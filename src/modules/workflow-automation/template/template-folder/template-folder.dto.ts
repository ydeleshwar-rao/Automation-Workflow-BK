// template-folder.dto.ts

export interface CreateTemplateFolderDTO {
  name: string;
  created_by: string;
  description?: string;
  parent_id?: string | null;
  is_public?: boolean;
}

export interface UpdateTemplateFolderDTO {
  name?: string;
  description?: string | null;
  parent_id?: string | null;
  is_public?: boolean;
}

export interface ListTemplateFoldersQuery {
  created_by?: string;
}

export interface BulkApplyFolderDTO {
  user_id: string;
  name_prefix?: string;
}
