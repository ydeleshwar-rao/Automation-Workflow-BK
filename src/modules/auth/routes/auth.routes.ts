import { Router }           from "express";
import { AuthController }   from "../controllers/auth.controller.js";
import { authMiddleware }   from "../../../middlewares/auth.middleware.js";
import { authRateLimiter }  from "../../../middlewares/rateLimiter.js";

const router = Router();

// Public routes (no auth required)
router.post("/login",        authRateLimiter, AuthController.login);
router.post("/google",       authRateLimiter, AuthController.google);
router.post("/register",     authRateLimiter, AuthController.register);
router.post("/refresh",      authRateLimiter, AuthController.refresh);
router.post("/logout",       AuthController.logout);

// Admin signup/setup. setup/status only tells whether zero admins exist.
router.get( "/setup/status", AuthController.setupStatus);
router.post("/setup",        authRateLimiter, AuthController.setup);

// Protected routes (require valid JWT)
router.get("/profile", authMiddleware, AuthController.getProfile);

export default router;
