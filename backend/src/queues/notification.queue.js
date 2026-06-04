import {Queue} from 'bullmq';
import {redis} from '../redis/index.js';

export const notificationQueue = new Queue(
    "notifications",
    {connection: redis,}
);