export const ApiResponse = (
    res: any,
    statusCode: number,
    message: string,
    data: any = null,
    meta?: Record<string, any>
) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        ...(meta ?? {}),
    });
}