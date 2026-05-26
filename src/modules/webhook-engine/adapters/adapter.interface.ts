/**
 * Normalized payload returned by an adapter's verifyAndNormalize().
 * The receiver uses this to log + dispatch the workflow.
 */
export interface WebhookEventNormalized {
  /** Vendor's unique event ID (used for idempotency / dedup) */
  externalId: string;
  /** Normalized event type (e.g. 'job.completed', 'contact.create') */
  eventType: string;
  /** Payload data passed to executeWorkflow as triggerData */
  data: Record<string, any>;
  /** ISO timestamp when the event happened on the vendor side */
  receivedAt: string;
}

/**
 * Result returned by adapter.subscribe().
 * • externalSubscriptionId may be null if subscription is managed at OAuth-app
 *   level (e.g. GHL marketplace dashboard) rather than per-user API call.
 * • signingSecret may be null if the vendor uses asymmetric crypto (Ed25519
 *   public key) or token-in-payload auth (ServiceM8) instead of HMAC.
 */
export interface SubscribeResult {
  externalSubscriptionId: string | null;
  signingSecret: string | null;
}

/**
 * Every integration that supports webhook (push) triggers must implement this.
 * The webhook engine calls these methods generically.
 */
export interface WebhookAdapter {
  /**
   * Register a webhook subscription with the vendor when a workflow trigger
   * is configured. For OAuth-app-level integrations (GHL), this can be a no-op
   * that just validates the eventKey is known.
   */
  subscribe(
    userId: string,
    eventKey: string,
    targetUrl: string,
    config: Record<string, any>
  ): Promise<SubscribeResult>;

  /**
   * Remove the subscription from the vendor side when the trigger is deleted.
   */
  unsubscribe(
    userId: string,
    externalSubscriptionId: string | null
  ): Promise<void>;

  /**
   * Verify the inbound webhook is genuine (signature check) and normalize the
   * payload. Returning null signals the caller to respond 401.
   */
  verifyAndNormalize(
    rawBody: string,
    headers: Record<string, string>,
    signingSecret: string | null
  ): WebhookEventNormalized | null;
}
