const ffmpeg = require('fluent-ffmpeg');
const ffprobe = require('node-ffprobe');
const PassThroughStream = require('stream').PassThrough;
const uuidv1 = require('uuid/v1');
const fs = require('fs');
const mkdirp = require('mkdirp');
const mkfifoSync = require('mkfifo').mkfifoSync;

const SOI = new Buffer([0xff, 0xd8]);
const EOI = new Buffer([0xff, 0xd9]);

class MjpegStreamToJpegs
{
	constructor( jpegCallback ) 
	{
		if (!Buffer.prototype['indexOf']) bufferTools.extend();
		this.jpegCallback = jpegCallback;
		this._buffer = null;
	}

	checkpoint( chunk ) 
	{
		let image = null;
		let imgStart, imgEnd;
		while (chunk) {
			if (this._buffer === null) {
				chunk = -1 != (imgStart = chunk.indexOf(SOI)) ? chunk.slice(imgStart) : null;
				if (chunk) this._buffer = new Buffer(0);
				continue;
			}

			if (-1 != (imgEnd = chunk.indexOf(EOI))) {
				imgEnd += EOI.length;
				image = Buffer.concat([this._buffer, chunk.slice(0, imgEnd)]);
				this.jpegCallback(image);
				this._buffer = null;
				chunk = chunk.slice(imgEnd);
				continue;
			}

			this._buffer = Buffer.concat( [this._buffer, chunk] );
			chunk = null;
		}
	}

	flush() {
		this._buffer = null;
	}
}

class ChunksFromFFmpegBase
{
	constructor( config, chunksCallback ) 
	{
		this.config = config || {};
		this.jobId =  uuidv1();
		this.output = new PassThroughStream();
		this.output.on('data', chunksCallback );
		this.output.on('error', this.onError.bind(this));
		this.command = null;

		mkdirp.sync('/tmp/jsmpeg');
	}

	onFFmpegStart( cmdline ) {
		//console.log( this.constructor.name, cmdline);
	}

	onFFmepgEnd () {
		console.log( this.constructor.name, ': ffmpeg processing finished !');
	}

	onError (err) {
		console.log( this.constructor.name, 'error occurred: ' + err.message);
		if (this.constructor.name === 'JpegsFromMp4File') {
			console.log(this.mp4File);
		}
	}

	stop() {
		this.command && this.command.kill('SIGKILL');
	}
}

class PcmListener extends ChunksFromFFmpegBase
{
	constructor( config, pcmCallback, endCallback ) 
	{
		super(config, pcmCallback);
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		this.loopFile = '/tmp/jsmpeg/loop-' + uuidv1() + '.pcm';
		mkfifoSync( this.loopFile, parseInt('0644', 8) );

		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [
			'-f s16le'
		];
		let outputOptions = this.config.outputOptions? this.config.outputOptions : [ 
			'-f s16le',
			'-c:a copy',
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.loopFile )
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this.loopFile;
	}

	stop() {
		ChunksFromFFmpegBase.stop.call(this);
		setTimeout( ()=>{
			fs.unlink( this.loopFile );
		}, 1000);
	}
}

class JpegsPcmFromFile extends ChunksFromFFmpegBase
{
	constructor( config, mediaFile, mjpegCallback, pcmCallback, endCallback ) 
	{
		super(config, mjpegCallback);
		this.pcmCallback= pcmCallback;
		this.mediaFile= mediaFile;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);

		ffprobe( this.mediaFile, (err, probeData) => {
			if (err) return;

			let hasVideo = false;
			let hasAudio = false;
			let outputIsUsed = false;

			probeData.streams.forEach( stream => {
				if ( stream.codec_type === 'video' ) {
					hasVideo = true;
					return;
				}
				if ( stream.codec_type === 'audio' ) {
					hasAudio = true;
				}
			});

			// handle input

			let inputOptions = this.config.inputOptions || [];
			this.command = ffmpeg()
				.input( this.mediaFile )
				.native()
				.inputOptions( inputOptions );

			// handle video output 
			
			if ( hasVideo ) {
				let videoSize = this.config.size || '1280x720';
				let videoFilters = this.config.filter || [
					'pad=0:iw:(ow-iw)/2:(oh-ih)/2', 
					'crop=iw:9/16*iw:0:(ih-oh)/2'
				];
				let outputVideoOptions = this.config.outputVideoOptions || [ 
					'-map 0:v',
					'-f mjpeg', 
					'-c:v mjpeg'
				];

				this.command.output( this.output )
					.outputOptions( outputVideoOptions )
					.videoFilters( videoFilters )
					.size( videoSize );

				outputIsUsed = true;
			}

			// handle audio output

			if ( hasAudio ) {
				if ( outputIsUsed ) {
					this.pcmListen = new PcmListener(this.config, this.pcmCallback, this.endCallback);
					let loopfifo = this.pcmListen.start();
					this.command.output( loopfifo );
				} else {
					this.output.on('data', this.pcmCallback);
					this.command.output( this.output );
				}

				let outputAudioOptions = this.config.outputAudioOptions || [ 
					'-map 0:a',
					'-f s16le',
					'-c:a pcm_s16le',
					'-ar 44100', '-ac 2', 
					'-fflags nobuffer',
					'-y'
				];

				this.command.outputOptions( outputAudioOptions );
			}

			this.command.on('start', callback)
				.on('error', this.errCallback)
				.on('end', this.endCallback)
				.run();
		});

		return this;
	}

	stop() {
		ChunksFromFFmpegBase.stop.call(this);
		setTimeout( ()=>{
			if (this.pcmListen) {
				this.pcmListen.stop();
			}
		}, 1000);
	}
}

class Mp3Listener extends ChunksFromFFmpegBase
{
	constructor( config, mp3Callback, endCallback ) 
	{
		super(config, mp3Callback);
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		this.loopFile = '/tmp/jsmpeg/loop-' + uuidv1() + '.mp3';
		mkfifoSync( this.loopFile, parseInt('0644', 8) );

		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [
			'-f mp3'
		];
		let outputOptions = this.config.outputOptions? this.config.outputOptions : [ 
			'-f mp3', 
			'-c:a copy', 
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.loopFile )
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this.loopFile;
	}

	stop() {
		ChunksFromFFmpegBase.stop.call(this);
		setTimeout( ()=>{
			fs.unlink( this.loopFile );
		}, 1000);
	}
}

class JpegsMp3FromFile extends ChunksFromFFmpegBase
{
	constructor( config, mp4File, mjpegCallback, mp3Callback, endCallback ) 
	{
		super(config, mjpegCallback);
		this.mp3Callback = mp3Callback;
		this.mp4File= mp4File;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		this.mp3Listen = new Mp3Listener(this.config, this.mp3Callback, this.endCallback);
		let loopfifo = this.mp3Listen.start();

		let inputOptions = this.config.inputOptions || [];
		let outputAudioOptions = this.config.outputAudioOptions || [ 
			'-map 0:a',
			'-f mp3', 
			'-c:a libmp3lame', 
			'-ar 44100', '-ab 128k', '-ac 2', 
			'-fflags nobuffer',
			'-y'
		];

		let outputVideoOptions = this.config.outputVideoOptions || [ 
			'-map 0:v',
			'-f mjpeg', 
			'-c:v mjpeg'
		];

		let videoFilters = this.config.filter || [
			'crop=iw:9/16*iw:0:(ih-oh)/2'
		];

		let videoSize = this.config.size || '1280x720';

		this.command = ffmpeg()
			.input( this.mp4File )
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputVideoOptions )
			.videoFilters( videoFilters )
			.size( videoSize )
			.output( loopfifo )
			.outputOptions( outputAudioOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}

	stop() {
		ChunksFromFFmpegBase.stop.call(this);
		setTimeout( ()=>{
			if (this.mp3Listen) {
				this.mp3Listen.stop();
			}
		}, 1000);
	}
}

class Mp3FromFile extends ChunksFromFFmpegBase
{
	constructor( config, mp4File, chunksCallback, endCallback ) 
	{
		super(config, chunksCallback);
		this.mp4File = mp4File;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [];
		let outputOptions = this.config.outputOptions? this.config.outputOptions : [ 
			'-map 0:a',
			'-f mp3', 
			'-acodec libmp3lame', 
			'-ar 44100', '-ab 128k', '-ac 2', 
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.mp4File)
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}

}

class PcmFromFile extends ChunksFromFFmpegBase
{
	constructor( config, inputMedia, chunksCallback, endCallback ) 
	{
		super(config, chunksCallback);
		this.inputMedia = inputMedia;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [];
		let outputOptions = this.config.outputOptions? this.config.outputOptions : [ 
			'-map 0:a',
			'-f s16le',
			'-acodec pcm_s16le',
			'-ar 44100', '-ac 2', 
			'-fflags nobuffer'
		];

		this.command = ffmpeg()
			.input( this.inputMedia)
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions( outputOptions )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}

}



class JpegsFromFFmpegBase extends ChunksFromFFmpegBase
{
	constructor( config, jpegsCallback ) 
	{
		let extractor = new MjpegStreamToJpegs( jpegsCallback );
		super( config, function(chunk) {
			extractor.checkpoint(chunk);
		});
	}
}

class JpegsFromMp4File extends JpegsFromFFmpegBase
{
	constructor( config, mp4File, jpegsCallback, endCallback ) 
	{
		super(config, jpegsCallback);
		this.mp4File = mp4File;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [];

		this.command = ffmpeg()
			.input( this.mp4File )
			.native()
			.inputOptions( inputOptions )
			.output( this.output )
			.outputOptions([ '-f mjpeg', '-c:v mjpeg' ])
			.videoFilters( this.config.filter )
			.size( this.config.size )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}
}

class JpegsFromWebCamera extends JpegsFromFFmpegBase
{
	constructor( config, url, jpegsCallback, endCallback, errCallback ) 
	{
		super(config, jpegsCallback);
		this.url = url;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = errCallback || this.onError.bind(this) ;
	}

	start (callback) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		let inputOptions = this.config.inputOptions? this.config.inputOptions : [];

		this.command = ffmpeg()
			.input(this.url)
			.inputOptions( inputOptions )
			.output(this.output)
			.outputOptions(['-f mjpeg', '-c:v mjpeg'])
			.videoFilters( this.config.filter )
			.size( this.config.size )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);
		this.command.run();
		return this;
	}
}

class JpegsFromUsbCamera extends JpegsFromFFmpegBase
{
	constructor( config, devPath, jpegsCallback, endCallback, errCallback ) 
	{
		super( config, jpegsCallback );
		this.devPath = devPath;
		this.command = null;
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = errCallback || this.onError.bind(this) ;
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
	
		let inputOptions = this.config.inputOptions? this.config.inputOptions : ['-f v4l2'];
		if (inputOptions.indexOf('-f v4l2') === -1) {
			inputOptions.push( '-f v4l2' );
		}

		this.command = ffmpeg()
			.input(this.devPath)
			.inputOptions( inputOptions )
			.output(this.output)
			.outputOptions(['-f mjpeg', '-c:v mjpeg'])
			.videoFilters( this.config.filter )
			.size( this.config.size )
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}
}

class Mpeg1tsFromJpegs extends ChunksFromFFmpegBase
{
	constructor( config, mpegtsCallback, qscale=8, endCallback ) 
	{
		super( config, mpegtsCallback );
		this.qscale = qscale;
		
		this.input = new PassThroughStream();
		this.input.on('error', this.onError.bind(this));
		this.endCallback = endCallback || this.onFFmepgEnd.bind(this) ;
		this.errCallback = endCallback || this.onError.bind(this) ;
	}

	write( chunk ) {
		this.input.write(chunk);	
	}

	start( callback ) 
	{
		callback = callback || this.onFFmpegStart.bind(this);
		this.command = ffmpeg()
			.input(this.input)
			.inputFormat('mjpeg')
			.output(this.output)
			.outputOptions(['-f mpegts', '-c:v mpeg1video', '-q:v '+ this.qscale, '-bf 0'])
			.outputFps(30)
			.on('start', callback)
			.on('error', this.errCallback)
			.on('end', this.endCallback);

		this.command.run();
		return this;
	}
}

class JpegsToLiveRtmp
{
	constructor( config, endCallback ) 
	{
		this.config = config;
		this.input = new PassThroughStream();
		this.input.on('error', endCallback);
		this.endCallback = endCallback;
	}

	write( chunk ) {
		this.input.write(chunk);	
	}

	onError( error, stdout, stderr ) 
	{
		console.debug(stdout);
		console.debug(stderr);
	}

	onEnd( error ) 
	{
		this.endCallback( error );
	}

	onStart( cmdline ) 
	{
		console.log( this.constructor.name, cmdline);
	}

	start( startCallback ) 
	{
		startCallback = startCallback || this.onStart.bind(this); 

		this.command = ffmpeg();
		this.command.input(this.input);
		this.command.inputFormat('mjpeg');

		this.config.inputs.forEach( (config) => {
			if (config.active !== undefined) {
				if (config.active !== true) {
					return;
				}
			}

			this.command.input( config.inputFrom );
			this.command.inputOptions( config.options );
		});

		this.config.outputs.forEach( (config) => {
			if (config.active !== undefined) {
				if (config.active !== true) {
					return;
				}
			}

			this.command.output( config.outputTo );
			this.command.outputOptions( config.options );
		});

		this.command.on('start', startCallback )
		this.command.on('error', this.onError.bind(this) );
		this.command.on('end', this.onEnd.bind(this) );
		this.command.run();
		return this;
	}
}

class LocalToLiveRtmp
{
	constructor( config, inputObj, endCallback ) 
	{
		this.config = config;
		this.endCallback = endCallback;
		this.input = inputObj.src;
		this.inputOptions = inputObj.options;
	}

	onError( error, stdout, stderr ) 
	{
		console.log(stdout);
		console.log(stderr);
		this.endCallback(error);
	}

	onEnd( error ) 
	{
		this.endCallback( error );
	}

	onStart( cmdline ) 
	{
		console.log( this.constructor.name, cmdline);
	}

	start( startCallback ) 
	{
		startCallback = startCallback || this.onStart.bind(this); 

		this.command = ffmpeg();

		this.command.input( this.input );
		this.command.inputOptions( this.inputOptions );

		this.config.outputs.forEach( (config) => {
			if (config.active !== undefined) {
				if (config.active !== true) {
					return;
				}
			}

			this.command.output( config.outputTo );
			this.command.outputOptions( config.options );
		});

		this.command.on('start', startCallback )
		this.command.on('error', this.onError.bind(this) );
		this.command.on('end', this.onEnd.bind(this) );
		this.command.run();
		return this;
	}

	stop() {
		this.command && this.command.kill('SIGKILL');
	}
}

module.exports = {
	Mpeg1tsFromJpegs,
	JpegsToLiveRtmp, LocalToLiveRtmp,
	JpegsFromWebCamera, JpegsFromUsbCamera, JpegsFromMp4File,
	Mp3FromFile, JpegsMp3FromFile,
	PcmFromFile, JpegsPcmFromFile
};