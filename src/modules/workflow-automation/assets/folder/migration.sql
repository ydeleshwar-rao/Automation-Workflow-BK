-- ============================================================================
-- Workflow folders & workflows: nesting, ordering, folder linkage
-- ============================================================================
-- Run this migration once against the Supabase database.
-- It is idempotent — safe to re-run.
-- ----------------------------------------------------------------------------

-- 1) workflow_folders: nesting + ordering -------------------------------------
ALTER TABLE public.workflow_folders
  ADD COLUMN IF NOT EXISTS parent_id uuid NULL
    REFERENCES public.workflow_folders(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_workflow_folders_parent
  ON public.workflow_folders USING btree (parent_id);

CREATE INDEX IF NOT EXISTS idx_workflow_folders_user_parent
  ON public.workflow_folders USING btree (user_id, parent_id);


-- 2) workflows: folder linkage + ordering -------------------------------------
ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS folder_id uuid NULL
    REFERENCES public.workflow_folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_workflows_folder
  ON public.workflows USING btree (folder_id);

CREATE INDEX IF NOT EXISTS idx_workflows_user_folder
  ON public.workflows USING btree (user_id, folder_id);
