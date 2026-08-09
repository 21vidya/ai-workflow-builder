import { Request, Response } from "express";

export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const { workflow_id } = req.body;

  if (!workflow_id) {
    return res.status(400).json({
      error: "workflow_id is required",
    });
  }

  return res.status(200).json({
    success: true,
    message: "triggerWorkflowRun received",
    workflow_id,
  });
}