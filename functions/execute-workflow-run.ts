import { Request, Response } from "express";

type JsonObject = Record<string, unknown>;

type WorkflowStep = {
  id: string;
  workflow_id: string;
  name: string;
  step_order: number;
  type: string;
  config: JsonObject | null;
};

type GraphQLResult<T> = {
  data?: T;
  errors?: Array<{
    message: string;
  }>;
};

export default async function handler(
  req: Request,
  res: Response
) {
  // -------------------------------------------------------
  // CORS
  // -------------------------------------------------------

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    // -----------------------------------------------------
    // Environment
    // -----------------------------------------------------

    const graphqlUrl =
      process.env.NHOST_GRAPHQL_URL;

    const adminSecret =
      process.env.NHOST_ADMIN_SECRET;

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

    // -----------------------------------------------------
    // Request
    // -----------------------------------------------------

    const body =
      req.body as JsonObject;

    const input =
      isObject(body?.input)
        ? body.input
        : body;

    const workflowRunId =
      getString(
        input.workflow_run_id
      );

    if (!workflowRunId) {
      return res.status(400).json({
        success: false,
        error:
          "workflow_run_id is required",
      });
    }

    console.log(
      "Executing workflow run:",
      workflowRunId
    );

    // -----------------------------------------------------
    // Get workflow run
    // -----------------------------------------------------

    const runQuery = `
      query GetWorkflowRun(
        $id: uuid!
      ) {
        workflow_runs_by_pk(
          id: $id
        ) {
          id
          workflow_id
          status
        }
      }
    `;

    const runResult =
      await graphqlRequest<{
        workflow_runs_by_pk: {
          id: string;
          workflow_id: string;
          status: string;
        } | null;
      }>(
        graphqlUrl,
        adminSecret,
        runQuery,
        {
          id: workflowRunId,
        }
      );

    const workflowRun =
      runResult.data
        ?.workflow_runs_by_pk;

    if (!workflowRun) {
      return res.status(404).json({
        success: false,
        error:
          "Workflow run not found",
      });
    }

    // -----------------------------------------------------
    // Get workflow steps
    // -----------------------------------------------------

    const stepsQuery = `
      query GetWorkflowSteps(
        $workflow_id: uuid!
      ) {
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
          name
          step_order
          type
          config
        }
      }
    `;

    const stepsResult =
      await graphqlRequest<{
        workflow_steps:
          WorkflowStep[];
      }>(
        graphqlUrl,
        adminSecret,
        stepsQuery,
        {
          workflow_id:
            workflowRun.workflow_id,
        }
      );

    const steps =
      stepsResult.data
        ?.workflow_steps || [];

    if (steps.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          "Workflow contains no steps",
      });
    }

    console.log(
      `Found ${steps.length} steps`
    );

    // -----------------------------------------------------
    // Execute each step
    // -----------------------------------------------------

    let previousOutput: unknown = null;

    for (const step of steps) {
      console.log(
        `Starting step ${step.step_order}: ${step.name}`
      );

      // -----------------------------------------------
      // Create/update step run
      // -----------------------------------------------

      const stepRunQuery = `
        query GetStepRun(
          $workflow_run_id: uuid!
          $step_id: uuid!
        ) {
          step_runs(
            where: {
              workflow_run_id: {
                _eq: $workflow_run_id
              }
              step_id: {
                _eq: $step_id
              }
            }
            limit: 1
          ) {
            id
            status
            input
            output
          }
        }
      `;

      const existingStepRunResult =
        await graphqlRequest<{
          step_runs: Array<{
            id: string;
            status: string;
            input: unknown;
            output: unknown;
          }>;
        }>(
          graphqlUrl,
          adminSecret,
          stepRunQuery,
          {
            workflow_run_id:
              workflowRunId,
            step_id: step.id,
          }
        );

      let stepRun =
        existingStepRunResult.data
          ?.step_runs?.[0];

      // -----------------------------------------------
      // If trigger didn't create it, create it
      // -----------------------------------------------

      if (!stepRun) {
        const createStepRunMutation = `
          mutation CreateStepRun(
            $workflow_run_id: uuid!
            $step_id: uuid!
          ) {
            insert_step_runs_one(
              object: {
                workflow_run_id: $workflow_run_id
                step_id: $step_id
                status: "running"
              }
            ) {
              id
              status
            }
          }
        `;

        const createdResult =
          await graphqlRequest<{
            insert_step_runs_one: {
              id: string;
              status: string;
            };
          }>(
            graphqlUrl,
            adminSecret,
            createStepRunMutation,
            {
              workflow_run_id:
                workflowRunId,
              step_id: step.id,
            }
          );

        const created =
          createdResult.data
            ?.insert_step_runs_one;

        if (!created) {
          throw new Error(
            `Could not create step run for ${step.name}`
          );
        }

        stepRun = {
          id: created.id,
          status: created.status,
          input: null,
          output: null,
        };
      }

      // -----------------------------------------------
      // Mark step running
      // -----------------------------------------------

      await updateStepRun(
        graphqlUrl,
        adminSecret,
        stepRun.id,
        "running"
      );

      try {
        // ---------------------------------------------
        // Execute step
        // ---------------------------------------------

        const output =
          await executeStep(
            step,
            previousOutput
          );

        previousOutput = output;

        // ---------------------------------------------
        // Mark completed
        // ---------------------------------------------

        await completeStepRun(
          graphqlUrl,
          adminSecret,
          stepRun.id,
          output
        );

        console.log(
          `Completed step ${step.step_order}: ${step.name}`
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          `Step failed: ${step.name}`,
          message
        );

        await failStepRun(
          graphqlUrl,
          adminSecret,
          stepRun.id,
          message
        );

        await failWorkflowRun(
          graphqlUrl,
          adminSecret,
          workflowRunId,
          message
        );

        return res.status(500).json({
          success: false,
          message:
            "Workflow execution failed",
          workflow_run_id:
            workflowRunId,
          failed_step:
            step.name,
          error: message,
        });
      }
    }

    // -----------------------------------------------------
    // Complete workflow
    // -----------------------------------------------------

    await completeWorkflowRun(
      graphqlUrl,
      adminSecret,
      workflowRunId
    );

    return res.status(200).json({
      success: true,
      message:
        "Workflow executed successfully",
      workflow_run_id:
        workflowRunId,
      steps_executed:
        steps.length,
      output:
        previousOutput,
    });
  } catch (error) {
    console.error(
      "Executor error:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}

// =========================================================
// Execute individual step
// =========================================================

async function executeStep(
  step: WorkflowStep,
  previousOutput: unknown
): Promise<unknown> {
  const config =
    step.config || {};

  switch (step.type) {
    // -----------------------------------------------------
    // LLM
    // -----------------------------------------------------

    case "llm_call": {
      const prompt =
        getString(
          config.prompt,
          "Process the input"
        );

      const model =
        getString(
          config.model,
          "default"
        );

      console.log(
        "LLM:",
        model,
        prompt
      );

      /*
       * Placeholder execution.
       *
       * Later this can be connected to OpenAI,
       * Gemini, Claude, etc.
       */

      return {
        type: "llm_call",
        model,
        prompt,
        input: previousOutput,
        result:
          "LLM step executed successfully",
      };
    }

    // -----------------------------------------------------
    // HTTP REQUEST
    // -----------------------------------------------------

    case "http_request": {
      const url =
        getString(config.url);

      if (!url) {
        throw new Error(
          "http_request requires url"
        );
      }

      const method =
        getString(
          config.method,
          "GET"
        ).toUpperCase();

      const headers:
        Record<string, string> = {};

      if (
        isObject(config.headers)
      ) {
        for (const [
          key,
          value,
        ] of Object.entries(
          config.headers
        )) {
          if (
            typeof value === "string"
          ) {
            headers[key] =
              value;
          }
        }
      }

      let requestBody:
        string | undefined;

      if (
        method !== "GET" &&
        method !== "HEAD"
      ) {
        const body =
          config.body !==
          undefined
            ? config.body
            : previousOutput;

        requestBody =
          typeof body === "string"
            ? body
            : JSON.stringify(body);

        if (
          !headers["Content-Type"]
        ) {
          headers["Content-Type"] =
            "application/json";
        }
      }

      const response =
        await fetch(url, {
          method,
          headers,
          ...(requestBody !==
          undefined
            ? {
                body: requestBody,
              }
            : {}),
        });

      const contentType =
        response.headers.get(
          "content-type"
        ) || "";

      let data: unknown;

      if (
        contentType.includes(
          "application/json"
        )
      ) {
        data =
          await response.json();
      } else {
        data =
          await response.text();
      }

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`
        );
      }

      return {
        status:
          response.status,
        body: data,
      };
    }

    // -----------------------------------------------------
    // CONDITIONAL
    // -----------------------------------------------------

    case "conditional_branch": {
      const field =
        getString(
          config.field
        );

      const expected =
        config.expected;

      let actual =
        previousOutput;

      if (
        field &&
        isObject(previousOutput)
      ) {
        actual =
          previousOutput[field];
      }

      const operator =
        getString(
          config.operator,
          "equals"
        );

      let condition =
        false;

      if (
        operator ===
        "equals"
      ) {
        condition =
          actual ===
          expected;
      } else if (
        operator ===
        "not_equals"
      ) {
        condition =
          actual !==
          expected;
      } else if (
        operator ===
        "contains"
      ) {
        condition =
          typeof actual ===
            "string" &&
          typeof expected ===
            "string" &&
          actual.includes(
            expected
          );
      } else if (
        operator ===
        "truthy"
      ) {
        condition =
          Boolean(actual);
      } else if (
        operator ===
        "falsy"
      ) {
        condition =
          !Boolean(actual);
      }

      return {
        condition,
        branch: condition
          ? getString(
              config.if_true,
              "continue"
            )
          : getString(
              config.if_false,
              "stop"
            ),
        value: actual,
      };
    }

    // -----------------------------------------------------
    // APPROVAL
    // -----------------------------------------------------

    case "approval_gate": {
      return {
        status:
          "approval_required",
        message:
          getString(
            config.message,
            "Approval required"
          ),
        input:
          previousOutput,
      };
    }

    // -----------------------------------------------------
    // NOTIFY
    // -----------------------------------------------------

    case "notify": {
      const message =
        getString(
          config.message,
          "Workflow notification"
        );

      console.log(
        "NOTIFICATION:",
        message
      );

      return {
        notified: true,
        message,
        input:
          previousOutput,
      };
    }

    // -----------------------------------------------------
    // DB WRITE
    // -----------------------------------------------------

    case "db_write": {
      return {
        type: "db_write",
        status:
          "prepared",
        data:
          previousOutput,
      };
    }

    // -----------------------------------------------------
    // Unknown
    // -----------------------------------------------------

    default:
      throw new Error(
        `Unsupported step type: ${step.type}`
      );
  }
}

// =========================================================
// GraphQL request
// =========================================================

async function graphqlRequest<T>(
  graphqlUrl: string,
  adminSecret: string,
  query: string,
  variables: Record<
    string,
    unknown
  >
): Promise<GraphQLResult<T>> {
  const response =
    await fetch(
      graphqlUrl,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json",
          "x-hasura-admin-secret":
            adminSecret,
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      }
    );

  const result =
    (await response.json()) as GraphQLResult<T>;

  if (!response.ok) {
    throw new Error(
      `GraphQL HTTP error: ${response.status}`
    );
  }

  if (
    result.errors &&
    result.errors.length > 0
  ) {
    throw new Error(
      result.errors
        .map(
          (e) => e.message
        )
        .join("; ")
    );
  }

  return result;
}

// =========================================================
// Update step run
// =========================================================

async function updateStepRun(
  graphqlUrl: string,
  adminSecret: string,
  id: string,
  status: string
) {
  const mutation = `
    mutation UpdateStepRun(
      $id: uuid!
      $status: String!
    ) {
      update_step_runs_by_pk(
        pk_columns: {
          id: $id
        }
        _set: {
          status: $status
        }
      ) {
        id
        status
      }
    }
  `;

  await graphqlRequest(
    graphqlUrl,
    adminSecret,
    mutation,
    {
      id,
      status,
    }
  );
}

// =========================================================
// Complete step run
// =========================================================

async function completeStepRun(
  graphqlUrl: string,
  adminSecret: string,
  id: string,
  output: unknown
) {
  const mutation = `
    mutation CompleteStepRun(
      $id: uuid!
      $output: jsonb
    ) {
      update_step_runs_by_pk(
        pk_columns: {
          id: $id
        }
        _set: {
          status: "completed"
          output: $output
        }
      ) {
        id
        status
      }
    }
  `;

  await graphqlRequest(
    graphqlUrl,
    adminSecret,
    mutation,
    {
      id,
      output: isObject(
        output
      )
        ? output
        : {
            value: output,
          },
    }
  );
}

// =========================================================
// Fail step run
// =========================================================

async function failStepRun(
  graphqlUrl: string,
  adminSecret: string,
  id: string,
  error: string
) {
  const mutation = `
    mutation FailStepRun(
      $id: uuid!
      $error: String
    ) {
      update_step_runs_by_pk(
        pk_columns: {
          id: $id
        }
        _set: {
          status: "failed"
          error: $error
        }
      ) {
        id
        status
      }
    }
  `;

  await graphqlRequest(
    graphqlUrl,
    adminSecret,
    mutation,
    {
      id,
      error,
    }
  );
}

// =========================================================
// Complete workflow
// =========================================================

async function completeWorkflowRun(
  graphqlUrl: string,
  adminSecret: string,
  id: string
) {
  const mutation = `
    mutation CompleteWorkflow(
      $id: uuid!
      $completed_at: timestamptz!
    ) {
      update_workflow_runs_by_pk(
        pk_columns: {
          id: $id
        }
        _set: {
          status: "completed"
          completed_at: $completed_at
        }
      ) {
        id
        status
        completed_at
      }
    }
  `;

  await graphqlRequest(
    graphqlUrl,
    adminSecret,
    mutation,
    {
      id,
      completed_at:
        new Date().toISOString(),
    }
  );
}

// =========================================================
// Fail workflow
// =========================================================

async function failWorkflowRun(
  graphqlUrl: string,
  adminSecret: string,
  id: string,
  error: string
) {
  const mutation = `
    mutation FailWorkflow(
      $id: uuid!
      $error: String
      $completed_at: timestamptz!
    ) {
      update_workflow_runs_by_pk(
        pk_columns: {
          id: $id
        }
        _set: {
          status: "failed"
          error: $error
          completed_at: $completed_at
        }
      ) {
        id
        status
      }
    }
  `;

  await graphqlRequest(
    graphqlUrl,
    adminSecret,
    mutation,
    {
      id,
      error,
      completed_at:
        new Date().toISOString(),
    }
  );
}

// =========================================================
// Utilities
// =========================================================

function isObject(
  value: unknown
): value is JsonObject {
  return (
    typeof value ===
      "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function getString(
  value: unknown,
  fallback = ""
): string {
  return typeof value ===
    "string"
    ? value
    : fallback;
}