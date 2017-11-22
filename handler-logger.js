
var FileOnWrite = require("file-on-write");

var writer = new FileOnWrite({ 
	path: './public/images',
	ext: '.bin'
});

class LoggerHandler 
{
	constructor (env) {
		this.handlerName = 'logger';
		this.chunkHead = 0x5b;	
		env.set('error', this.error.bind(this));
		env.set('debug', this.debug.bind(this));
		env.set('console', this.console.bind(this));
	}

	onDownRequest (socket, req) {

	}

	log (name, message) {

	}

	error (message) {
		this.log('error', message);
	}

	debug (message) {
		this.log('debug', message);
	}

	console (message) {
		console.log(message);
	}



}

module.exports = LoggerHandler;