import { Request, Response } from "express";

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    console.log("Incoming body:", JSON.stringify(req.body));

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

    const graphqlUrl = process.env.NHOST_GRAPHQL_URL;
    const adminSecret = process.env.NHOST_ADMIN_SECRET;

    if (!graphqlUrl) {
      throw new Error("NHOST_GRAPHQL_URL is not configured");
    }

    if (!adminSecret) {
      throw new Error("NHOST_ADMIN_SECRET is not configured");
    }

    // Check that the workflow exists
    const query = `
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

    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify({
        query,
        variables: {
          workflow_id,
        },
      }),
    });

    const result = await response.json();

    console.log("GraphQL result:", JSON.stringify(result));

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

    const workflows = result.data?.workflows ?? [];

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

    return res.status(200).json({
      success: true,
      message: "Workflow found successfully",
      workflow_id: workflow.id,
      workflow_name: workflow.name,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error("Function error:", message);

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
}