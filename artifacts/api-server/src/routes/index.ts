import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ttsRouter from "./tts";
import commentsRouter from "./comments";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ttsRouter);
router.use(commentsRouter);

export default router;
