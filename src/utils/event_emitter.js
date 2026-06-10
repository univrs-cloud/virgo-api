import { EventEmitter } from 'events';

// Create a singleton EventEmitter instance for internal plugin communication
const eventEmitter = new EventEmitter();

export default eventEmitter;
