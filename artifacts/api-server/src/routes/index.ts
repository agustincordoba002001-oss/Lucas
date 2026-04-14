import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ttsRouter from "./tts";
import commentsRouter from "./comments";
import voiceRouter from "./voice";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ttsRouter);
router.use(commentsRouter);
router.use(voiceRouter);

export default router;
