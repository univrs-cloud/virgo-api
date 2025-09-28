const { EventEmitter } = require('events');

// Create a singleton EventEmitter instance for internal plugin communication
const eventEmitter = new EventEmitter();

module.exports = eventEmitter;
