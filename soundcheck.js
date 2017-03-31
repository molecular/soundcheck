#!/usr/bin/env node

var cmd = require('commander');
var config = require('./config');
var request = require('request');
var rp = require('request-promise');
var fs = require('fs');
var _ = require('lodash');
var stream = require('stream');
var unzip_extract = require('unzip').Extract;
var unzip_parse = require('unzip').Parse;


var unzip = function( filename, dirname ) {
	console.log("unzipping", filename);
	var zip_destination = config.paths.unzip + '/' + dirname;
	fs.createReadStream( filename )
	.pipe(unzip_extract({ path: zip_destination }));

	console.log( "\nunpacking zip to", zip_destination, '\n---------------------------------\n' );
	fs.createReadStream( filename )
	  .pipe(unzip_parse())
	  .on('entry', function (entry) {
		var fileName = entry.path;
		var type = entry.type; // 'Directory' or 'File'
		var size = entry.size;
		console.log( "writing", fileName );
		// create locally deep directory if necessary
		var file_path_array = fileName.split('/');
		file_path_array.pop();
		var dir = zip_destination + '/' + file_path_array.join('/');
		if ( !fs.existsSync( dir ) ) {
			fs.mkdirSync( dir );
		}
		// write the file
		entry.pipe(fs.createWriteStream( zip_destination + '/' + fileName ));
	  })
	  .on('close', () => {
		console.log("deleting file", filename);
		fs.unlink( filename, () => {
			console.log("deleted file", filename);
		})
	  });

}

var premiumize_delete = function( id, callback ) {
console.log("premiumize_delete(", id, ")");
	request.post( 'https://www.premiumize.me/api/item/delete',  {
		form: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			type: 'torrent',
			id: id
		}
	}, ( err, response, body ) => {
console.log("delete response.statusCode", response.statusCode);
console.log("delete body", body);
console.log("delete response.body", response.body);
		if ( callback ) callback( id );
	} );
}

var download_content = function( transfer, premiumize_content, finished_callback ) {
//console.log("downloading content:", premiumize_content );
	if ( premiumize_content.zip ) {
		var local_filename = config.paths.download + '/' + premiumize_content.name + '.zip';
		request.get( { url: premiumize_content.zip, encoding: null }, ( error, message, body ) => {
//console.log("content dl finished, error", error, "message", message);
			// call callback
			finished_callback( transfer.id );
			// unzip
			unzip( local_filename, premiumize_content.name );
		})
/*		.on( 'data', ( chunk ) => {
			console.log(chunk.length);
		})*/
		.pipe( 
			fs.createWriteStream( local_filename )
		);
		console.log("\ndownload of", premiumize_content.zip + " => ", local_filename );
	} else {
		console.log("the following premiumize_content is not a zip:", premiumize_content, 'not unpacking.' );
		finished_callback( transfer.id );
	}
}

var in_progress = {};
var should_dl = {};
var premiumize_download = function( transfer ) {
	if ( !in_progress[ transfer.id ] && should_dl[ transfer.id ] ) { 
		console.log( "downloading id", transfer.id, "named", transfer.name );
		in_progress[ transfer.id ] = transfer;
		request.post( 'https://www.premiumize.me/api/torrent/browse', {
			form: {
				customer_id: config.premiumize.customer_id,
				pin: config.premiumize.pin,
				hash: transfer.hash
			}
		}, ( err, response, body ) => {
			var body = JSON.parse( body );
			_.values( body.content ).forEach( ( content ) => {
				download_content( transfer, content, ( id ) => {
					console.log( "download finished, deleting premiumize id", id );
					premiumize_delete( id, ( id ) => {
						console.log("id", id, "deleted");					
					} );
				} );
			})
		} );
	}
}

var premiumize_progress = () => {
	
	request.post( 'https://www.premiumize.me/api/transfer/list', {
		form: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin
		}
	}, ( err, response, body ) => {
		var body = JSON.parse( body );
		var transfers = body.transfers;

		_.forEach( transfers, ( transfer ) => {
			console.log("   ", transfer.id, ':', transfer.status, ' - ', transfer.name ? transfer.name.substring(0, 40) : "", ', ', transfer.message );
		});

		transfers_by_status = _.reduce( transfers, ( o, t ) => {
			if ( !o[t.status] ) o[t.status] = [];
				o[t.status][t.id] = t;
				return o;
		}, {});

//console.log("transfers_by_status", transfers_by_status['finished']);

		// first filter all transfers by id 
		transfers = _.filter( body.transfers, ( transfer ) => {
			return should_dl[transfer.id];
		});

		// handle finished transfers
		_.forEach( _.values( transfers_by_status['finished'] ), ( transfer ) => {
			premiumize_download( transfer );
		});

		// condense transfer list by transfer.id filtering for status==''
		var downloading_by_id = _.reduce( transfers, ( map, transfer ) => {
			if ( transfer.status !== 'finished' ) {
				map[ transfer.id ] = transfer;
			}
			return map;
		}, {} );

		if ( _.size( downloading_by_id ) > 0 ) {
			setTimeout( premiumize_progress, config.poll_interval_msecs, id );
		}
	} );
}

var premiumize_handler = (err, response, body) => {
	if ( err ) {
		console.log("premiumize_handler err: ", err);
	} else {
//console.log("preimiumize api response received: ", response );
		console.log("preimiumize api response received. body: ", body );
		body = JSON.parse( body );
		if ( !body.status === 'success' ) {
		} else {
	console.log("body.type", body.type);
			if ( body.type === 'torrent' ) {
				should_dl[ body.id ] = true;
				premiumize_progress( body.id );
			}
		}
	}
}

var queue_torrent_url = function( url ) {
	var torrent_content_stream = stream.Readable();

	// mofo shit jooou! how to elegantly stream GET -> POST w/o tmp file???

	// request torrent file content
	request.get( url ).pipe( fs.createWriteStream( 'tmp.torrent' ) )
	queue_torrent_file( 'tmp.torrent' );
}

var add_torrent_files = function( files ) {
	if ( !_.isArray( files ) ) files = [ files ];
	console.log( "add_torrent_files(): ", files );
	_.forEach( files, queue_torrent_file );
}

var add_torrent_urls = function( urls ) {
	if ( !_.isArray( urls ) ) urls = [ urls ];
	console.log( "add_torrent_urls(): ", urls );
	_.forEach( urls, ( url ) => {
		if ( url.startsWith( 'file://' ) ) {
			queue_torrent_file( url.substring( 6 ) );
		} else {
			queue_torrent_url( url );
		}
	});
}

var queue_torrent_file = function( filename ) {
	if ( filename.indexOf('*') ) return;
	request.post( 'https://www.premiumize.me/api/transfer/create?type=torrent', {
		formData: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			src: fs.createReadStream( filename )
		}
	}, (err, response, body) => {
		fs.unlink( filename, () => {
			console.log("deleted file", filename);
		})
	});
}

var download_by_id = function( ids ) {
	if ( !_.isArray( ids ) ) ids = [ ids ];
	console.log( "download_by_id(): ", ids );
	_.forEach( ids, ( id ) => {
		should_dl[ id ] = true;
	});
	premiumize_progress();
}

var remove_by_id = function( ids ) {
	if ( !_.isArray( ids ) ) ids = [ ids ];
	console.log( "remove_by_id(): ", ids );
	_.forEach( ids, ( id ) => {
		premiumize_delete( id, ( x ) => {
			console.log( "delete response: ", x );
		} );
	});
}

var unzip_file = function( file ) {
	console.log("unzipping", file, "to", config.paths.unzip );
	var dest_dir = file.split('/').pop();
	dest_dir = dest_dir.split('.')[0];
	console.log("dest_dir", dest_dir);
	unzip( file, dest_dir );	
}

var unzip_files = function( files ) {
	if ( !_.isArray( files ) ) files = [ files ];
	console.log( "unzip_files(): ", files );
	_.forEach( files, unzip_file );
}

// commander 

cmd
	.version('0.1.0')

cmd
	.command( 'add_torrent_files <file...>' )
	.description( 'add torrent files to remote downloader and delete it' )
	.alias( 'atf' )
	.action( add_torrent_files );

cmd
	.command( 'add_torrent_urls <url...>' )
	.description( 'add torrent urls to remote downloader and delete it' )
	.alias( 'atu' )
	.action( add_torrent_urls );

cmd
	.command( 'list', 'list downloads' )
	.description( 'list remote downloader items' )
	.alias( 'l' )
	.action( premiumize_progress );

cmd
	.command( 'download <id...>' )
	.description( 'download to local filesystem by id' )
	.alias( 'dl' )
	.action( download_by_id );

cmd
	.command( 'remove <id...>' )
	.description( 'remove remote file by id' )
	.alias( 'rm' )
	.action( remove_by_id );

cmd
	.command( 'unzip <file...>' )
	.description( 'unzip local file(s)' )
	.alias( 'u' )
	.action( unzip_files );

cmd
	.option('-x, --unzip <zipfile>', 'unzip zipfile to config.paths.unzip' )

	.option('-w, --wait', 'wait for transfers to finish and try to handle them')

cmd.parse(process.argv);

