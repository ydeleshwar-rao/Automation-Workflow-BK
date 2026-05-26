/**
 * Result from a single polled record.
 */
export interface PollResult {
  /** Unique ID from the external system (e.g. ServiceM8 job uuid) */
  externalId: string;
  /** Full record payload — becomes triggerData for executeWorkflow */
  data: Record<string, any>;
  /** Value to store as the new cursor (e.g. edit_date) */
  cursorValue: string;
}

/**
 * Every integration that supports polling triggers must implement this interface.
 * The polling engine calls these methods generically — all integration-specific
 * logic lives inside the adapter.
 */
export interface PollingAdapter {
  /**
   * Poll the external API for records matching the event type.
   * Must return records ordered by cursorValue ascending.
   *
   * @param userId      - User whose OAuth tokens to use
   * @param eventKey    - e.g. 'job_completed', 'new_client'
   * @param config      - Event-specific filters from polling_subscriptions.config
   * @param cursorValue - Last known cursor value (null on first poll)
   */
  poll(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    cursorValue: string | null
  ): Promise<PollResult[]>;

  /**
   * Return up to N sample records for the Test step UI (Zapier-style preview).
   * Empty array means no records were found.
   */
  fetchSample(
    userId: string,
    eventKey: string,
    config: Record<string, any>,
    limit?: number
  ): Promise<Record<string, any>[]>;
}
