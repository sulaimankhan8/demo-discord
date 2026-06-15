import { EventEmitter } from 'events';

export const eventBus = new EventEmitter();

eventBus.setMaxListeners(100); // Set a higher limit for listeners if needed