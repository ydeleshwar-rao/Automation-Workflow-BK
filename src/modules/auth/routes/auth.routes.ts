import { Router }           from "express";
import { AuthController }   from "../controllers/auth.controller.js";
import { authMiddleware }   from "../../../middlewares/auth.middleware.js";
import { authRateLimiter }  from "../../../middlewares/rateLimiter.js";

const router = Router();

// Public routes (no auth required)
router.post("/login",        authRateLimiter, AuthController.login);
router.post("/register",     authRateLimiter, AuthController.register);
router.post("/refresh",      authRateLimiter, AuthController.refresh);

// First-time setup (blocked once an admin exists)
router.get( "/setup/status", AuthController.setupStatus);
router.post("/setup",        authRateLimiter, AuthController.setup);

// Protected routes (require valid JWT)
router.get("/profile", authMiddleware, AuthController.getProfile);

export default router;
