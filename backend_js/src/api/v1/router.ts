import { Router } from 'express';
import { healthRouter } from './endpoints/health.js';
import { authRouter } from './endpoints/auth.js';
import { webhooksRouter } from './endpoints/webhooks.js';
import { platformConnectionsRouter } from './endpoints/platform_connections.js';
import { inboxRouter } from './endpoints/inbox.js';
import { commentsRouter } from './endpoints/comments.js';
import { postsRouter } from './endpoints/posts.js';
import { accountsRouter } from './endpoints/accounts.js';
import { usersRouter } from './endpoints/users.js';

export const v1Router = Router();

v1Router.use('/health', healthRouter);
v1Router.use('/auth', authRouter);
v1Router.use('/webhooks', webhooksRouter);
v1Router.use('/platform-connections', platformConnectionsRouter);
v1Router.use('/inbox', inboxRouter);
v1Router.use('/comments', commentsRouter);
v1Router.use('/posts', postsRouter);
v1Router.use('/accounts', accountsRouter);
v1Router.use('/users', usersRouter);

export default v1Router;
