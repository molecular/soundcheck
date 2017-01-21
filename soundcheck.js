#!/usr/bin/env node

var cmd = require('commander');
var config = require('./config');
var request = require('request');
var fs = require('fs');
var _ = require('lodash');
var stream = require('stream');
var unzip_extract = require('unzip').Extract;
var unzip_parse = require('unzip').Parse;

cmd
  .version('0.1.0')
  .option('-t, --torrent <url|file_url>', 'Download Torrents using either url to torrent file or local torrent file (see --torrent_url and --torrent_file). url is detected to be local file if it starts with "file://"')
  .option('-u, --torrent_url <url>', 'Download Torrent using torrent file from the net. <url> is the url ot the torrent file.')
  .option('-f, --torrent_file <file>', 'Download Torrent using torrent file from local filesystem. <file> is the local path to the torrent file.')

  .option('-x, --unzip <zipfile>', 'unzip zipfile to config.paths.unzip' )

  .option('-w, --wait', 'wait for transfers to finish and try to handle them')
  .parse(process.argv);

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
	  });	

}

var premiumize_delete = function( id, callback ) {
console.log("premiumize_delete(", id, ")");
	request.post( 'https://www.premiumize.me/api/folder/delete',  {
		form: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			id: id
		}
	}, ( err, response, body ) => {
console.log("delete response.statusCode", response.statusCode);
//console.log("delete callback(", id, "), response", response);
		if ( callback ) callback( id );
	} );
}

var download_content = function( transfer, premiumize_content, finished_callback ) {
//console.log("downloading content:", premiumize_content );
	if ( premiumize_content.zip ) {
		var local_filename = config.paths.download + '/' + premiumize_content.name + '.zip';
		request.get( { url: premiumize_content.zip, encoding: null }, ( error, message, body ) => {
console.log("content dl finished, error", error, "message", message);
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
var premiumize_download = function( transfer ) {
	if ( !in_progress[ transfer.id ] ) { 
console.log( "downloading transfer", transfer );
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

var premiumize_progress = ( id ) => {
console.log( "progress called on id", id );

	request.post( 'https://www.premiumize.me/api/transfer/list', {
		form: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin
		}
	}, ( err, response, body ) => {
		var body = JSON.parse( body );
		var transfers = body.transfers;

		_.forEach( transfers, ( transfer ) => {
			console.log("   ", transfer.id.substring(0, 8), ':', transfer.status, ' - ', transfer.name ? transfer.name.substring(0, 24) : "", ', ', transfer.message );
		});

		transfers_by_status = _.reduce( transfers, ( o, t ) => {
			if ( !o[t.status] ) o[t.status] = [];
				o[t.status][t.id] = t;
				return o;
		}, {});

//console.log("transfers_by_status", transfers_by_status['finished']);

		// first filter all transfers by id (we download a single id here)
		transfers = _.filter( body.transfers, ( transfer ) => {
			return id === undefined || transfer.id == id;
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

var queue_torrent_file = function( filename ) {
	request.post( 'https://www.premiumize.me/api/transfer/create?type=torrent', {
		formData: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			src: fs.createReadStream( filename )
		}
	}, premiumize_handler );
}

if ( cmd.unzip ) {
	console.log("unzipping", cmd.unzip, "to", config.paths.unzip );
	unzip( cmd.unzip, config.paths.unzip );	
}

if ( cmd.torrent ) {
	console.log( 'torrents: ', cmd.torrent );
	if ( cmd.torrent.startsWith( 'file://' ) ) {
		queue_torrent_file( cmd.torrent.substring( 6 ) );
	} else {
		queue_torrent_url( cmd.torrent );
	}
}

if ( cmd.torrent_url ) {
	console.log( 'torrent urls:', cmd.torrent_url );
	queue_torrent_url( cmd.torrent_url );
}


if ( cmd.torrent_file ) {
	console.log( 'torrent files:', cmd.torrent_file );
	queue_torrent_file( cmd.torrent_file );
}

if ( cmd.wait ) {
	premiumize_progress();
}