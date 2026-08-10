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

  // Handle browser preflight request
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // Only POST is allowed
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    console.log(
      "Incoming body:",
      JSON.stringify(req.body)
    );

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
    const graphqlUrl = process.env.NHOST_GRAPHQL_URL;
    const adminSecret = process.env.NHOST_ADMIN_SECRET;

    if (!graphqlUrl) {
      throw new Error(
        "NHOST_GRAPHQL_URL is not configured"
      );
    }

    if (!adminSecret) {
      throw new Error(
        "NHOST_ADMIN_SECRET is not configured"
      );
    }
    const graphqlEndpoint: string = graphqlUrl;
    const graphqlAdminSecret: string = adminSecret;
    // --------------------------------------------------
    // 3. GraphQL helper
    // --------------------------------------------------
    async function graphqlRequest(
      query: string,
      variables: Record<string, unknown>
    ) {
      const response = await fetch(graphqlEndpoint, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-hasura-admin-secret": graphqlAdminSecret,
        },

        body: JSON.stringify({
          query,
          variables,
        }),
      });

      const result: {
        data?: {
          workflows?: Array<{
            id: string;
            name: string;
          }>;
          workflow_steps?: Array<{
            id: string;
            workflow_id: string;
            step_order: number;
            name: string;
            type: string;
            config: unknown;
          }>;
          insert_workflow_runs_one?: {
            id: string;
            workflow_id: string;
            status: string;
            started_at: string | null;
          };
          insert_step_runs_one?: {
            id: string;
            workflow_run_id: string;
            step_id: string;
            status: string;
            input: unknown;
          };
        };
        errors?: Array<{
          message: string;
        }>;
      } = await response.json();

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
            .map(
              (error: { message: string }) =>
                error.message
            )
            .join(", ")
        );
      }

      return result.data;
    }

    // --------------------------------------------------
    // 4. Find workflow
    // --------------------------------------------------
    const workflowQuery = `
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

    const workflowData = await graphqlRequest(
      workflowQuery,
      {
        workflow_id,
      }
    );

    const workflows =
      workflowData?.workflows ?? [];

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
    // 5. Get workflow steps
    // --------------------------------------------------
    const stepsQuery = `
      query GetWorkflowSteps($workflow_id: uuid!) {
        workflow_steps(
          where: {
            workflow_id: {
              _eq: $workflow_id
            }
          }
          order_by: {
            step_order: asc
          }
        ) {
          id
          workflow_id
          step_order
          name
          type
          config
        }
      }
    `;

    const stepsData = await graphqlRequest(
      stepsQuery,
      {
        workflow_id,
      }
    );

    const steps =
      stepsData?.workflow_steps ?? [];

    console.log(
      `Found ${steps.length} workflow steps`
    );

    if (steps.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Workflow has no steps",
        workflow_id,
      });
    }

    // --------------------------------------------------
    // 6. Create workflow run
    // --------------------------------------------------
    const createWorkflowRunMutation = `
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
        }
      }
    `;

    const runData = await graphqlRequest(
      createWorkflowRunMutation,
      {
        workflow_id,
        status: "running",
      }
    );

    const workflowRun =
      runData?.insert_workflow_runs_one;

    if (!workflowRun) {
      throw new Error(
        "Failed to create workflow run"
      );
    }

    console.log(
      `Workflow run created: ${workflowRun.id}`
    );

    // --------------------------------------------------
    // 7. Create step runs
    // --------------------------------------------------
    const stepRunResults: Array<{
      step_id: string;
      step_name: string;
      step_order: number;
      type: string;
      step_run_id: string | undefined;
      status: string | undefined;
    }> = [];

    for (const step of steps) {
      const createStepRunMutation = `
        mutation CreateStepRun(
          $workflow_run_id: uuid!
          $step_id: uuid!
          $status: String!
          $input: jsonb
        ) {
          insert_step_runs_one(
            object: {
              workflow_run_id: $workflow_run_id
              step_id: $step_id
              status: $status
              input: $input
            }
          ) {
            id
            workflow_run_id
            step_id
            status
            input
          }
        }
      `;

      const stepRunData =
        await graphqlRequest(
          createStepRunMutation,
          {
            workflow_run_id: workflowRun.id,
            step_id: step.id,
            status: "pending",
            input: {},
          }
        );

      const stepRun =
        stepRunData?.insert_step_runs_one;

      stepRunResults.push({
        step_id: step.id,
        step_name: step.name,
        step_order: step.step_order,
        type: step.type,
        step_run_id: stepRun?.id,
        status: stepRun?.status,
      });
    }

    // --------------------------------------------------
    // 8. Return success
    // --------------------------------------------------
    return res.status(200).json({
      success: true,
      message:
        "Workflow run created successfully",

      workflow: {
        id: workflow.id,
        name: workflow.name,
      },

      workflow_run: {
        id: workflowRun.id,
        workflow_id: workflowRun.workflow_id,
        status: workflowRun.status,
        started_at: workflowRun.started_at,
      },

      steps: stepRunResults,
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