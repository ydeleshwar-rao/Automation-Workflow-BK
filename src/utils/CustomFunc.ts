export function validateId(Id: string | string[] | undefined): asserts Id is string {
  if (!Id || typeof Id !== "string") {
    throw new Error("Valid Id is required");
  }
}