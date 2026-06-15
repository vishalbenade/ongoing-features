// ── Context-scoped logger ───────────────────────────────────────────────────

  /**
   * Returns a ContextLogger bound to a fixed component/context name,
   * so every call is automatically tagged with `component: context`.
   *
   * Usage:
   *   private readonly logger = inject(LoggerService).forContext('MarketDataStreamService');
   *   this.logger.info('Stream connected');
   */
  forContext(context: string, baseMeta: Record<string, unknown> = {}): ContextLogger {
    return {
      debug: (message: string, meta?: Record<string, unknown>) =>
        this.debug(message, { component: context, ...baseMeta, ...meta }),
      info: (message: string, meta?: Record<string, unknown>) =>
        this.info(message, { component: context, ...baseMeta, ...meta }),
      warn: (message: string, meta?: Record<string, unknown>) =>
        this.warn(message, { component: context, ...baseMeta, ...meta }),
      error: (message: string, meta?: Record<string, unknown>) =>
        this.error(message, { component: context, ...baseMeta, ...meta }),
    };
  }
