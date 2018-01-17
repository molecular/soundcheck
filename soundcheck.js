#!/usr/bin/env node

const cmd = require('commander');
const config = require('./config');
const request = require('request');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const stream = require('stream');
const unzip_extract = require('unzip').Extract;
const unzip_parse = require('unzip').Parse;


var unzip = function( filename ) {
	console.log("unzipping", filename);
	var zip_destination = config.paths.unzip;
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
		var full_path = zip_destination + '/' + fileName;
		var file_path_array =  full_path.split('/');
		file_path_array.pop();
		file_path_array.forEach( (dir, index, splits ) => {
			const parent = splits.slice(0, index).join('/');
			const dirPath = path.resolve(parent, dir);
			if (!fs.existsSync(dirPath)) {
				try {
					fs.mkdirSync(dirPath);
				} catch( err ) {
					console.log( "mkdir error: ", err );
				}
			}
		});

		// write the file
		entry.pipe(fs.createWriteStream( zip_destination + '/' + fileName ));
	  })
	  .on('close', () => {
		fs.unlink( filename, () => {
			console.log("deleted zip file", filename);
		})
	  });

}

var premiumize_delete = function( id, callback ) {
console.log("premiumize_delete(", id, ")");
	request.post( 'https://www.premiumize.me/api/transfer/delete',  {
		form: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			type: 'torrent',
			id: id
		}
	}, ( err, response, body ) => {
		console.log("delete response.body", response.body);
		if ( callback ) callback( id );
	} );
}

var download_content = function( transfer, zip_uri, finished_callback ) {
	console.log("downloading zip of transfer:", transfer.name );
	var downloaded_bytes = 0;
	var chunk_counter = 0;
	var local_filename = config.paths.download + '/' + transfer.name + '.zip';

	console.log("\n <= ", zip_uri + " \n => ", local_filename );

	request.get( { url: zip_uri, encoding: null })
	
	// progress meter
	.on( 'data', ( chunk ) => {
		//console.log(chunk.length);
		downloaded_bytes += chunk.length;
		chunk_counter += 1;
		if ( (chunk_counter % 330) == 0 ) {
			process.stdout.write( "\rdownloaded " + Math.round(downloaded_bytes/(1024*1024)) + ' MiB' );
		}
	})
	
	// download finished
	.on( 'end', () => {
		// progress meter newline
		process.stdout.write('\n');
		// unzip
		unzip( local_filename );
		// call callback
		finished_callback( transfer.id );
	})		

	// pipe content to local zip file
	.pipe(
		fs.createWriteStream( local_filename )
	);
}

var in_progress = {};
var should_dl = {};
var premiumize_download = function( transfer ) {
	if ( !in_progress[ transfer.id ] && should_dl[ transfer.id ] ) { 
		console.log( "downloading (generating zip first) id", transfer.id, "named", transfer.name );
		// console.log( "transfer: ", transfer);
		in_progress[ transfer.id ] = transfer;
		
		request.post( 'https://www.premiumize.me/api/zip/generate', {
			form: {
				customer_id: config.premiumize.customer_id,
				pin: config.premiumize.pin,
				items: [{
					name: transfer.name,
					id: transfer.folder_id,
					type: 'folder'
				}]
			}
		}, ( err, response, body ) => {
			var body = JSON.parse( body );
			//console.log("zip/create response body", body);
			download_content( transfer, body.location, ( id ) => {
				console.log( "download finished, deleting premiumize id", id );
				premiumize_delete( id, ( id ) => {
					console.log("id", id, "deleted");					
				} );
			} );
		} );

/*	old api, not supported any more it seems (no transfer.hash)		
	request.post( 'https://www.premiumize.me/api/torrent/browse', {
			form: {
				customer_id: config.premiumize.customer_id,
				pin: config.premiumize.pin,
				hash: transfer.hash
			}
		}, ( err, response, body ) => {
			var body = JSON.parse( body );
			console.log("body", body);
			_.values( body.content ).forEach( ( content ) => {
				download_content( transfer, content, ( id ) => {
					console.log( "download finished, deleting premiumize id", id );
					premiumize_delete( id, ( id ) => {
						console.log("id", id, "deleted");					
					} );
				} );
			})
		} );*/
	}
}

var print_transfers = function( description, transfers ) {
	console.log( "\n--- " + description + " ---\n" );
	_.forEach( transfers, ( transfer ) => {
		console.log(
			(should_dl[transfer.id] ? "  * " : "   "),
			transfer.id, ':', 
			transfer.status, ' - ', 
			transfer.name ? transfer.name.substring(0, 40) : "",
			', ', transfer.message 
		);
	});
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

		print_transfers( "finished transfers", _.filter( transfers, (t) => { return t.status == 'finished'; } ) );
		print_transfers( "unfinished transfers ( * : will dl )", _.filter( transfers, (t) => { return t.status != 'finished'; } ) );

		transfers_by_status = _.reduce( transfers, ( o, t ) => {
			if ( !o[t.status] ) o[t.status] = [];
				o[t.status][t.id] = t;
				return o;
		}, {});

		// first filter all transfers by should_dl
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
			setTimeout( premiumize_progress, config.poll_interval_msecs );
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
	if ( cmd.wait ) premiumize_progress();
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
	if ( cmd.wait ) premiumize_progress();
}

var queue_torrent_file = function( filename ) {
	if ( filename.indexOf('*') >= 0 ) return;
	request.post( 'https://www.premiumize.me/api/transfer/create?type=torrent', {
		formData: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			src: fs.createReadStream( filename )
		}
	}, (err, response, body) => {
//console.log("err:", err);
		body = JSON.parse( body );
		if ( body.status == 'success' && body.id !== undefined ) {
			fs.unlink( filename, () => {
				console.log("deleted file", filename);
			})
			//download_by_id( body.id );
		} else {
			console.log("transfer problem");
			console.log("transfer response:", body);
			console.log("transfer err:", err);
		}
	});
	if ( cmd.wait ) premiumize_progress();
}

var download_by_id = function( ids ) {
	if ( !_.isArray( ids ) ) ids = [ ids ];
	console.log( "download_by_id(): ", ids );
	_.forEach( ids, ( id ) => {
		should_dl[ id ] = true;
	});
	premiumize_progress();
}

var leech = function( count ) {
	request.post( 'https://www.premiumize.me/api/transfer/list', {
		form: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin
		}
	}, ( err, response, body ) => {
		var body = JSON.parse( body );
		var transfers = body.transfers;

		transfers = _.filter( body.transfers, ( transfer ) => {
			return transfer.status == 'finished';
		});

		_.forEach( transfers.splice(0, count), ( transfer ) => {
			download_by_id( transfer.id );
		});
	});
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
	unzip( file );	
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
	.command( 'list' )
	.description( 'list remote downloader items' )
	.alias( 'ls' )
	.action( premiumize_progress );

cmd
	.command( 'download <id...>' )
	.description( 'download to local filesystem by id' )
	.alias( 'dl' )
	.action( download_by_id );

cmd
	.command( 'leech <count>' )
	.description( 'download to local filesystem any finished transfers' )
	.action( leech );


cmd
	.command( 'remove <id...>' )
	.description( 'remove remote file by id' )
	.alias( 'rm' )
	.action( remove_by_id );

cmd
	.command( 'unzip <file...>' )
	.description( 'unzip local file(s)' )
	.alias( 'x' )
	.action( unzip_files );

cmd
	.option('-w, --wait', 'wait for transfers to finish and try to handle them')

cmd.parse(process.argv);

