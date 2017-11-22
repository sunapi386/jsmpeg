
module.exports = class MJpegHandler 
{
	constructor(env) 
	{
		this.handlerName = 'mjpeg';
		this.nodeId = env.get('nodeId');
		this.config = env.get('getConfig')();
		this.cache = env.get('newCache')();
		this.eachClient = env.get('eachClient');
		this.chunkHead = 0xFFD8;	
		this.feed_list = new Array();
		this.upstreamLastTime = Date.now();

		this.mjpegName = this.config.mjpegStreamName? this.config.mjpegStreamName : 'seed.mjpeg';
		this.mjpeUrl= '/mjpeg/' + this.mjpegName;
		this.mjpegBoundary = 'MjpegBoundary';
		this.mjpegAudience = new Array();

		this.interval = this.config.mjpegUpdateInterval? parseInt(this.config.mjpegUpdateInterval) : 100;


	}

	http( req, res )
	{
		if (req.url !== this.mjpeUrl ) {
			res.json({status: 'error', error: 'command error.'});
			return;
		}

		this.mjpegStream( req, res );
	}

	feedMjpegStream( jpeg ) 
	{
		let content = Buffer(jpeg);
		let head =  '--' + this.mjpegBoundary + "\r\n" +
			"Content-Type: image/jpeg\r\n" + 
			"Content-Length: " + content.length + "\r\n\r\n";

		this.mjpegAudience.forEach( function( res ) {
			res.write( head );
			res.write( content, 'binary');
			res.write("\r\n");
		});
	}

	mjpegStream( req, res )
	{
		let self = this;
		self.mjpegAudience.push( res );

		res.writeHead(200, {
			'Content-Type': 'multipart/x-mixed-replace;boundary=' + self.mjpegBoundary,
			'Connection': 'keep-alive',
			'Expires': 'Mon, 01 Jul 1980 00:00:00 GMT',
			'Cache-Control': 'no-cache, no-store, must-revalidate',
			'Pragma': 'no-cache'
		});

		res.socket.on('close', function () {
			console.log('exiting mjpeg client!');
			self.mjpegAudience.splice(self.mjpegAudience.indexOf(res), 1);
		});
	}

	infos () 
	{
		let activeCount = this.cache.keys().length;
		return {
			mjpegClientCount: activeCount,
			mjpegActiveCount: activeCount
		};
	}

	onUpConnect (socket, cmd = 'active') 
	{
		let nowTime = Date.now();

		socket.send(JSON.stringify({
			userId: this.nodeId,
			handler: this.handlerName,
			cmd: cmd,
			req_time: nowTime - this.upstreamLastTime,
			draw_time: 0
		}));

		this.upstreamLastTime = nowTime;
	}

	onUpResponse( chunk, socket ) 
	{
		this.downstream( chunk );

		setTimeout(function(){
			this.onUpConnect(socket, 'interval');
		}.bind(this), this.interval);
	}

	feed (chunk) 
	{
		this.downstream (chunk);
	}

	downstream( chunk ) 
	{
		this.feedMjpegStream( chunk );

		if (this.feed_list.length === 0) {
			return;
		}

		this.eachClient(function each(client) {
			client.send(chunk);
		}, this.feed_list);

		this.feed_list.length = 0;
	}

	onDownConnect (socket) 
	{
	}

	onDownRequest (socket, req) 
	{
		let userId = req.userId;
		this.cache.set(userId, Date.now(), 5);

		 switch (req.cmd) {
		 	case 'active':
				console.log(req);
			case 'interval':
				this.feed_list.push(socket);
				break;

			default:
				console.log('cmd not handled: ', req);
		 }
	}

};

