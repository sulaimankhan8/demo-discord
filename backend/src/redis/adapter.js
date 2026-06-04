import {redis} from "./index.js";

export const pubClient= redis;

export const subClient = redis.duplicate();