import { Router } from 'express';
import { v1Router } from './v1/router.js';

export const apiRouter = Router();

apiRouter.use('/', v1Router);
export default apiRouter;
