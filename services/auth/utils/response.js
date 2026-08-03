export const responseHandler = (data, res, message, status) => {
    const statusCode = status || 200;
    res.status(statusCode).json({
        statusCode,
        success: true,
        message: message || "Success",
        data,
    });
};
