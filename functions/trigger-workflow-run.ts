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

    console.log("Received workflow_id:", workflow_id);

    return res.status(200).json({
      success: true,
      message: "triggerWorkflowRun received",
      workflow_id,
    });
  } catch (error) {
    console.error("Function error:", error);

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}