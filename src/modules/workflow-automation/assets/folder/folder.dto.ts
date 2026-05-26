export interface CreateFolderDTO {
  name: string;
  user_id: string;
  parent_id?: string | null;
  position?: number;
}

export interface UpdateFolderDTO {
  name?: string;
  parent_id?: string | null;
  position?: number;
}

export interface ReorderFoldersDTO {
  items: { id: string; parent_id: string | null; position: number }[];
}
