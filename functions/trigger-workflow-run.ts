import { Request, Response } from "express";

/* =========================================================
   Types
   ========================================================= */

type JsonObject = Record<string, unknown>;

type WorkflowStep = {
  id: string;
  workflow_id: string;
  name: string;
  step_order: number;
  type: string;
  config: JsonObject | null;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{
    message: string;
  }>;
};

/* =========================================================
   Helper functions
   ========================================================= */

function isObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function getString(
  value: unknown,
  defaultValue = ""
): string {
  return typeof value === "string"
    ? value
    : defaultValue;
}

/* =========================================================
   Main handler
   ========================================================= */

export default async function handler(
  req: Request,
  res: Response
) {
  /* -------------------------------------------------------
     CORS
     ------------------------------------------------------- */

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

  /* -------------------------------------------------------
     OPTIONS request
     ------------------------------------------------------- */

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  /* -------------------------------------------------------
     Only POST allowed
     ------------------------------------------------------- */

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed",
    });
  }

  try {
    console.log(
      "Incoming request:",
      JSON.stringify(req.body)
    );

    /* -----------------------------------------------------
       Environment variables
       ----------------------------------------------------- */

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

    /* -----------------------------------------------------
       Request body
       ----------------------------------------------------- */

    const body = asObject(req.body);

    const input = asObject(body.input);

    const workflowId = getString(
      input.workflow_id
    );

    if (!workflowId) {
      return res.status(400).json({
        success: false,
        error:
          "workflow_id is required",
      });
    }

    console.log(
      "Starting workflow:",
      workflowId
    );

    /* -----------------------------------------------------
       Get workflow
       ----------------------------------------------------- */

    const workflowQuery = `
      query GetWorkflow($workflow_id: uuid!) {
        workflows(
          where: {
            id: {
              _eq: $workflow_id
            }
          }
          limit: 1
        ) {
          id
          name
          description
        }
      }
    `;

    const workflowResult =
      await graphqlRequest<{
        workflows: Array<{
          id: string;
          name: string;
          description: string | null;
        }>;
      }>(
        graphqlUrl,
        adminSecret,
        workflowQuery,
        {
          workflow_id: workflowId,
        }
      );

    const workflows =
      workflowResult.data?.workflows || [];

    if (workflows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Workflow not found",
        workflow_id: workflowId,
      });
    }

    const workflow = workflows[0];

    console.log(
      "Workflow found:",
      workflow.name
    );

    /* -----------------------------------------------------
       Get workflow steps
       ----------------------------------------------------- */

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
        workflow_steps: WorkflowStep[];
      }>(
        graphqlUrl,
        adminSecret,
        stepsQuery,
        {
          workflow_id: workflowId,
        }
      );

    const steps =
      stepsResult.data?.workflow_steps || [];

    if (steps.length === 0) {
      return res.status(400).json({
        success: false,
        error:
          "Workflow has no steps",
        workflow_id: workflowId,
      });
    }

    console.log(
      `Found ${steps.length} workflow steps`
    );

    /* -----------------------------------------------------
       Create workflow run
       ----------------------------------------------------- */

    const createRunMutation = `
      mutation CreateWorkflowRun(
        $workflow_id: uuid!
      ) {
        insert_workflow_runs_one(
          object: {
            workflow_id: $workflow_id
            status: "running"
          }
        ) {
          id
          workflow_id
          status
          started_at
        }
      }
    `;

    const runResult =
      await graphqlRequest<{
        insert_workflow_runs_one: {
          id: string;
          workflow_id: string;
          status: string;
          started_at: string;
        };
      }>(
        graphqlUrl,
        adminSecret,
        createRunMutation,
        {
          workflow_id: workflowId,
        }
      );

    const workflowRun =
      runResult.data
        ?.insert_workflow_runs_one;

    if (!workflowRun) {
      throw new Error(
        "Failed to create workflow run"
      );
    }

    console.log(
      "Workflow run created:",
      workflowRun.id
    );

    /* -----------------------------------------------------
       Runtime data
       ----------------------------------------------------- */

    let currentData: unknown =
      input.data ?? input;

    let previousOutput: unknown =
      null;

    /* -----------------------------------------------------
       Execute steps
       ----------------------------------------------------- */

    for (const step of steps) {
      console.log(
        `Executing step ${step.step_order}: ${step.name} (${step.type})`
      );

      /* ---------------------------------------------------
         Create step run
         --------------------------------------------------- */

      const createStepRunMutation = `
        mutation CreateStepRun(
          $workflow_run_id: uuid!
          $step_id: uuid!
          $input: jsonb
        ) {
          insert_step_runs_one(
            object: {
              workflow_run_id: $workflow_run_id
              step_id: $step_id
              status: "running"
              input: $input
              started_at: "now()"
            }
          ) {
            id
            status
          }
        }
      `;

      /*
       * Hasura does not accept "now()" as a GraphQL
       * string value for every schema configuration.
       * Therefore use the simpler mutation below.
       */

      const actualStepRunMutation = `
        mutation CreateStepRun(
          $workflow_run_id: uuid!
          $step_id: uuid!
          $input: jsonb
        ) {
          insert_step_runs_one(
            object: {
              workflow_run_id: $workflow_run_id
              step_id: $step_id
              status: "running"
              input: $input
            }
          ) {
            id
            status
          }
        }
      `;

      const stepRunResult =
        await graphqlRequest<{
          insert_step_runs_one: {
            id: string;
            status: string;
          };
        }>(
          graphqlUrl,
          adminSecret,
          actualStepRunMutation,
          {
            workflow_run_id:
              workflowRun.id,
            step_id: step.id,
            input:
              isObject(currentData)
                ? currentData
                : {
                    value: currentData,
                  },
          }
        );

      const stepRun =
        stepRunResult.data
          ?.insert_step_runs_one;

      if (!stepRun) {
        throw new Error(
          `Failed to create step run for ${step.name}`
        );
      }

      try {
        /* -----------------------------------------------
           Execute step
           ----------------------------------------------- */

        const output =
          await executeStep(
            step,
            currentData,
            previousOutput,
            graphqlUrl,
            adminSecret
          );

        previousOutput = output;
        currentData = output;

        /* -----------------------------------------------
           Mark step completed
           ----------------------------------------------- */

        const updateStepRunMutation = `
          mutation UpdateStepRun(
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
          updateStepRunMutation,
          {
            id: stepRun.id,
            output: isObject(output)
              ? output
              : {
                  value: output,
                },
          }
        );

        console.log(
          `Step completed: ${step.name}`
        );
      } catch (stepError) {
        const errorMessage =
          stepError instanceof Error
            ? stepError.message
            : String(stepError);

        console.error(
          `Step failed: ${step.name}`,
          errorMessage
        );

        /* ---------------------------------------------
           Mark step failed
           --------------------------------------------- */

        const failedStepMutation = `
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
          failedStepMutation,
          {
            id: stepRun.id,
            error: errorMessage,
          }
        );

        /* ---------------------------------------------
           Mark workflow failed
           --------------------------------------------- */

        const failedWorkflowMutation = `
          mutation FailWorkflowRun(
            $id: uuid!
            $error: String
          ) {
            update_workflow_runs_by_pk(
              pk_columns: {
                id: $id
              }
              _set: {
                status: "failed"
                error: $error
                completed_at: "2026-01-01T00:00:00Z"
              }
            ) {
              id
              status
            }
          }
        `;

        /*
         * Instead of using a fake timestamp,
         * use the current ISO timestamp through
         * a separate mutation below.
         */

        const now =
          new Date().toISOString();

        const realFailedWorkflowMutation = `
          mutation FailWorkflowRun(
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
          realFailedWorkflowMutation,
          {
            id: workflowRun.id,
            error: errorMessage,
            completed_at: now,
          }
        );

        return res.status(500).json({
          success: false,
          message:
            "Workflow execution failed",
          workflow_id: workflowId,
          workflow_run_id:
            workflowRun.id,
          failed_step: step.name,
          error: errorMessage,
        });
      }
    }

    /* -----------------------------------------------------
       Workflow completed
       ----------------------------------------------------- */

    const completedAt =
      new Date().toISOString();

    const completeWorkflowMutation = `
      mutation CompleteWorkflowRun(
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

    const completedResult =
      await graphqlRequest<{
        update_workflow_runs_by_pk: {
          id: string;
          status: string;
          completed_at: string;
        };
      }>(
        graphqlUrl,
        adminSecret,
        completeWorkflowMutation,
        {
          id: workflowRun.id,
          completed_at: completedAt,
        }
      );

    const completedRun =
      completedResult.data
        ?.update_workflow_runs_by_pk;

    console.log(
      "Workflow completed:",
      workflow.name
    );

    /* -----------------------------------------------------
       Success response
       ----------------------------------------------------- */

    return res.status(200).json({
      success: true,
      message:
        "Workflow executed successfully",
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      workflow_run_id: workflowRun.id,
      status:
        completedRun?.status ||
        "completed",
      steps_executed: steps.length,
      output: currentData,
    });
  } catch (error) {
    /* -----------------------------------------------------
       Global error
       ----------------------------------------------------- */

    console.error(
      "Workflow execution error:",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
}

/* =========================================================
   GraphQL helper
   ========================================================= */

async function graphqlRequest<T>(
  graphqlUrl: string,
  adminSecret: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<GraphQLResponse<T>> {
  const response = await fetch(
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

  let result: GraphQLResponse<T>;

  try {
    result =
      (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new Error(
      `GraphQL server returned invalid JSON (${response.status})`
    );
  }

  console.log(
    "GraphQL response:",
    JSON.stringify(result)
  );

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
          (error) =>
            error.message
        )
        .join("; ")
    );
  }

  return result;
}

/* =========================================================
   Step executor
   ========================================================= */

async function executeStep(
  step: WorkflowStep,
  currentData: unknown,
  previousOutput: unknown,
  graphqlUrl: string,
  adminSecret: string
): Promise<unknown> {
  const config =
    step.config || {};

  console.log(
    "Step config:",
    JSON.stringify(config)
  );

  switch (step.type) {
    /* =====================================================
       LLM CALL
       ===================================================== */

    case "llm_call": {
      /*
       * This step is kept generic because the project can
       * connect to whichever AI provider you configure.
       *
       * If a response is already supplied in config,
       * return it.
       */

      const prompt =
        getString(config.prompt);

      const model =
        getString(
          config.model,
          "default"
        );

      console.log(
        "LLM step:",
        model,
        prompt
      );

      return {
        type: "llm_call",
        model,
        prompt,
        input: currentData,
        message:
          "LLM step prepared successfully",
      };
    }

    /* =====================================================
       HTTP REQUEST
       ===================================================== */

    case "http_request": {
      return await executeHttpRequest(
        config,
        currentData
      );
    }

    /* =====================================================
       DATABASE WRITE
       ===================================================== */

    case "db_write": {
      return await executeDatabaseWrite(
        config,
        currentData,
        graphqlUrl,
        adminSecret
      );
    }

    /* =====================================================
       NOTIFY
       ===================================================== */

    case "notify": {
      return executeNotify(
        config,
        currentData
      );
    }

    /* =====================================================
       CONDITIONAL BRANCH
       ===================================================== */

    case "conditional_branch": {
      return executeConditionalBranch(
        config,
        currentData,
        previousOutput
      );
    }

    /* =====================================================
       APPROVAL GATE
       ===================================================== */

    case "approval_gate": {
      return executeApprovalGate(
        config,
        currentData
      );
    }

    /* =====================================================
       UNKNOWN TYPE
       ===================================================== */

    default: {
      throw new Error(
        `Unsupported workflow step type: ${step.type}`
      );
    }
  }
}

/* =========================================================
   HTTP request step
   ========================================================= */

async function executeHttpRequest(
  config: JsonObject,
  currentData: unknown
): Promise<JsonObject> {
  const url =
    getString(config.url);

  if (!url) {
    throw new Error(
      "http_request step requires a valid url"
    );
  }

  const method =
    getString(
      config.method,
      "GET"
    ).toUpperCase();

  /* -------------------------------------------------------
     Headers
     ------------------------------------------------------- */

  const headers: Record<
    string,
    string
  > = {};

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
        headers[key] = value;
      }
    }
  }

  /* -------------------------------------------------------
     Request body
     ------------------------------------------------------- */

  let body:
    | string
    | undefined;

  if (
    method !== "GET" &&
    method !== "HEAD"
  ) {
    const configuredBody =
      config.body !== undefined
        ? config.body
        : currentData;

    if (
      typeof configuredBody ===
      "string"
    ) {
      body = configuredBody;
    } else {
      body =
        JSON.stringify(
          configuredBody
        );
    }

    if (
      !headers["Content-Type"]
    ) {
      headers["Content-Type"] =
        "application/json";
    }
  }

  console.log(
    `HTTP ${method} ${url}`
  );

  /* -------------------------------------------------------
     Fetch
     ------------------------------------------------------- */

  const response =
    await fetch(url, {
      method,
      headers,
      ...(body !== undefined
        ? { body }
        : {}),
    });

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  let responseBody: unknown;

  if (
    contentType.includes(
      "application/json"
    )
  ) {
    responseBody =
      await response.json();
  } else {
    responseBody =
      await response.text();
  }

  if (!response.ok) {
    throw new Error(
      `HTTP request failed: ${response.status} ${response.statusText}`
    );
  }

  return {
    status: response.status,
    status_text:
      response.statusText,
    body: responseBody,
  };
}

/* =========================================================
   Database write step
   ========================================================= */

async function executeDatabaseWrite(
  config: JsonObject,
  currentData: unknown,
  graphqlUrl: string,
  adminSecret: string
): Promise<JsonObject> {
  const table =
    getString(config.table);

  if (!table) {
    throw new Error(
      "db_write step requires table"
    );
  }

  /*
   * For safety, only allow normal PostgreSQL table
   * identifiers.
   */

  if (
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(
      table
    )
  ) {
    throw new Error(
      "Invalid database table name"
    );
  }

  const data =
    isObject(config.data)
      ? config.data
      : isObject(currentData)
        ? currentData
        : {
            value: currentData,
          };

  /*
   * Convert table name to a Hasura GraphQL mutation
   * name.
   */

  const mutationName =
    `insert_${table}_one`;

  const mutation = `
    mutation InsertData(
      $object: ${table}_insert_input!
    ) {
      ${mutationName}(
        object: $object
      ) {
        id
      }
    }
  `;

  const result =
    await graphqlRequest<
      Record<string, unknown>
    >(
      graphqlUrl,
      adminSecret,
      mutation,
      {
        object: data,
      }
    );

  return {
    success: true,
    table,
    result:
      result.data || null,
  };
}

/* =========================================================
   Notify step
   ========================================================= */

function executeNotify(
  config: JsonObject,
  currentData: unknown
): JsonObject {
  const message =
    getString(
      config.message,
      "Workflow notification"
    );

  const channel =
    getString(
      config.channel,
      "log"
    );

  console.log(
    `NOTIFY [${channel}]: ${message}`
  );

  return {
    success: true,
    channel,
    message,
    data: currentData,
  };
}

/* =========================================================
   Conditional branch
   ========================================================= */

function executeConditionalBranch(
  config: JsonObject,
  currentData: unknown,
  previousOutput: unknown
): JsonObject {
  const value =
    config.value !== undefined
      ? config.value
      : currentData;

  const field =
    getString(config.field);

  const expected =
    config.expected;

  let actual: unknown =
    value;

  if (
    field &&
    isObject(value)
  ) {
    actual =
      value[field];
  }

  let condition = false;

  const operator =
    getString(
      config.operator,
      "equals"
    );

  switch (operator) {
    case "equals":
    case "eq":
      condition =
        actual === expected;
      break;

    case "not_equals":
    case "neq":
      condition =
        actual !== expected;
      break;

    case "contains":
      condition =
        typeof actual ===
          "string" &&
        typeof expected ===
          "string" &&
        actual.includes(
          expected
        );
      break;

    case "exists":
      condition =
        actual !==
          undefined &&
        actual !== null;
      break;

    case "truthy":
      condition =
        Boolean(actual);
      break;

    case "falsy":
      condition =
        !Boolean(actual);
      break;

    default:
      condition = Boolean(
        actual
      );
  }

  const ifTrue =
    getString(
      config.if_true,
      "continue"
    );

  const ifFalse =
    getString(
      config.if_false,
      "stop"
    );

  const branch =
    condition
      ? ifTrue
      : ifFalse;

  console.log(
    "Conditional result:",
    {
      actual,
      expected,
      condition,
      branch,
    }
  );

  return {
    condition,
    branch,
    actual,
    expected,
    previous_output:
      previousOutput,
  };
}

/* =========================================================
   Approval gate
   ========================================================= */

function executeApprovalGate(
  config: JsonObject,
  currentData: unknown
): JsonObject {
  const message =
    getString(
      config.message,
      "Approval required"
    );

  /*
   * The workflow is marked as waiting for approval.
   * A future approval function/UI can update the run.
   */

  console.log(
    "Approval required:",
    message
  );

  return {
    status:
      "approval_required",
    message,
    data: currentData,
  };
}