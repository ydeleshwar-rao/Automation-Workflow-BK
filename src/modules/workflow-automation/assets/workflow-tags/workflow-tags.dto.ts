export interface CreateWorkflowTagDTO {
  name: string;
  color?: string;
  user_id: string;
}

export interface UpdateWorkflowTagDTO {
  name?: string;
  color?: string;
}
