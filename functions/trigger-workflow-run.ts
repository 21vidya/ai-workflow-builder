import { Request, Response } from "express";

export default async function handler(req: Request, res: Response) {
  // --------------------------------------------------
  // CORS
  // --------------------------------------------------
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // --------------------------------------------------
  // Only POST is allowed
  // --------------------------------------------------
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    console.log("Incoming body:", JSON.stringify(req.body));

    // --------------------------------------------------
    // 1. Get workflow_id
    // --------------------------------------------------
    const workflow_id =
      req.body?.input?.workflow_id ??
      req.body?.workflow_id;

    if (!workflow_id) {
      return res.status(400).json({
        success: false,
        error: "workflow_id is required",
        received_body: req.body,
      });
    }

    // --------------------------------------------------
    // 2. Environment variables
    // --------------------------------------------------
    const graphqlUrl: string =
  process.env.NHOST_GRAPHQL_URL ?? "";

const adminSecret: string =
  process.env.NHOST_ADMIN_SECRET ?? "";

if (!graphqlUrl) {
  throw new Error("NHOST_GRAPHQL_URL is not configured");
}

if (!adminSecret) {
  throw new Error("NHOST_ADMIN_SECRET is not configured");
}

    // --------------------------------------------------
    // 3. GraphQL helper
    // --------------------------------------------------
    async function graphqlRequest(
      query: string,
      variables: Record<string, unknown>
    ) {
      const response = await fetch(graphqlUrl!, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-hasura-admin-secret": adminSecret,
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      const result = await response.json();

      console.log(
        "GraphQL result:",
        JSON.stringify(result)
      );

      if (!response.ok) {
        throw new Error(
          `GraphQL request failed: ${response.status}`
        );
      }

      if (result.errors) {
        throw new Error(
          result.errors
            .map((error: { message: string }) => error.message)
            .join(", ")
        );
      }

      return result;
    }

    // --------------------------------------------------
    // 4. Check workflow exists
    // --------------------------------------------------
    const getWorkflowQuery = `
      query GetWorkflow($workflow_id: uuid!) {
        workflows(
          where: {
            id: {
              _eq: $workflow_id
            }
          }
        ) {
          id
          name
        }
      }
    `;

    const workflowResult = await graphqlRequest(
      getWorkflowQuery,
      {
        workflow_id,
      }
    );

    const workflows =
      workflowResult.data?.workflows ?? [];

    if (workflows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Workflow not found",
        workflow_id,
      });
    }

    const workflow = workflows[0];

    console.log(
      `Workflow found: ${workflow.name} (${workflow.id})`
    );

    // --------------------------------------------------
    // 5. Create workflow_runs row
    // --------------------------------------------------
    const createRunMutation = `
      mutation CreateWorkflowRun(
        $workflow_id: uuid!
        $status: String!
      ) {
        insert_workflow_runs_one(
          object: {
            workflow_id: $workflow_id
            status: $status
          }
        ) {
          id
          workflow_id
          status
          started_at
          completed_at
          error
        }
      }
    `;

    const runResult = await graphqlRequest(
      createRunMutation,
      {
        workflow_id: workflow.id,
        status: "running",
      }
    );

    const workflowRun =
      runResult.data?.insert_workflow_runs_one;

    if (!workflowRun) {
      throw new Error(
        "Failed to create workflow run"
      );
    }

    console.log(
      `Workflow run created: ${workflowRun.id}`
    );

    // --------------------------------------------------
    // 6. Return success
    // --------------------------------------------------
    return res.status(200).json({
      success: true,
      message: "Workflow run created successfully",
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      workflow_run_id: workflowRun.id,
      status: workflowRun.status,
    });

  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "Function error:",
      message
    );

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
}