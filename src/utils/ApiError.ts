// export class ApiError extends Error {
//   statusCode: number;
//   data: unknown | null;
//   success: boolean;
//   errors: unknown[];
//   code: string | undefined;
//   meta: Record<string, unknown> | undefined;

//   constructor(
//     statusCode: number,
//     message: string = "Something went wrong",
//     errors: unknown[] = [],
//     stack: string = "",
//     code?: string,
//     meta?: Record<string, unknown>
//   ) {
//     super(message);
//     this.statusCode = statusCode;
//     this.data = null;
//     this.message = message;
//     this.success = false;
//     this.errors = errors;
//     this.code = code;
//     this.meta = meta;

//     if (stack) {
//       this.stack = stack;
//     } else {
//       Error.captureStackTrace(this, this.constructor);
//     }
//   }
// }



export class ApiError extends Error {
  statusCode: number;
  success: boolean;
  errors: unknown[];
  code?: string | undefined;
  data?: unknown;
  meta?: Record<string, unknown> | undefined;

  constructor(
    statusCode: number,
    message = "Something went wrong",
    options?: {
      errors?: unknown[];
      code?: string;
      data?: unknown;
      meta?: Record<string, unknown>;
      cause?: unknown;
    }
  ) {
    super(message);

    this.statusCode = statusCode;
    this.success = false;
    this.errors = options?.errors ?? [];
    this.code = options?.code;
    this.data = options?.data;
    this.meta = options?.meta;

    if (options?.cause) {
      (this as any).cause = options.cause;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}
