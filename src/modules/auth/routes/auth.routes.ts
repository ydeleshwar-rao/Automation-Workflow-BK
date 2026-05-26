import { Router } from "express";
import { AuthController } from "../controllers/auth.controller.js";
import { authMiddleware } from "../../../middlewares/auth.middleware.js";
import { authRateLimiter } from "../../../middlewares/rateLimiter.js";

const router = Router();

router.post("/login", authRateLimiter, AuthController.login);
router.get("/profile", authMiddleware, AuthController.getProfile);
router.post("/register", authRateLimiter, AuthController.register);
router.post("/session/refresh", authRateLimiter, AuthController.sessionRefresh);
router.post("/refresh", authRateLimiter, AuthController.sessionRefresh);


export default router;
