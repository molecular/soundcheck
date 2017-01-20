#!/usr/bin/env node

var cmd = require('commander');
var config = require('./config');
var request = require('request');
var fs = require('fs');
var _ = require('lodash');
var stream = require('stream');

cmd
  .version('0.1.0')
  .option('-u, --torrent_url <url>', 'Download Torrent')
  .option('-f, --torrent_file <file>', 'Download Torrent')
  .parse(process.argv);

var download_content = function( premiumize_content ) {
	var local_filename = config.paths.download + '/' + premiumize_content.name + '.zip';
	request.get( premiumize_content.zip ).pipe( 
		fs.createWriteStream( local_filename )
	);
	console.log("download started to", local_filename );
}

var premiumize_download = function( transfer ) {
	console.log( "downloading transfer", transfer );
	request.post( 'https://www.premiumize.me/api/torrent/browse', {
		form: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			hash: transfer.hash
		}
	}, ( err, response, body ) => {
		var body = JSON.parse( body );
		_.values( body.content ).forEach( ( content ) => {
			download_content( content );
		})
	} );
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

		// condense transfer list by transfer.id
		var finished_by_id = _.reduce( body.transfers, ( map, transfer ) => {
			if ( transfer.status == 'finished' ) {
				map[ transfer.id ] = transfer;
			}
			return map;
		}, {} );

		premiumize_download( finished_by_id[ id ] );
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
	request.get( url).pipe( fs.createWriteStream( 'tmp.torrent' ) )
}

/*	request
		.get( url, ( error, response, body ) => {
			torrent_content_stream.push( body );
		});
*/
/*		.on( 'response', ( response ) => {
			console.log("response.statusCode: ", response.statusCode );
//console.log("torrent file response: ", response );
			console.log("\n\n\n-------------\ntorrent file response.body: ", response.body );
			torrent_content_stream.push( )
		});
*/

var queue_torrent_file = function( filename ) {
	request.post( 'https://www.premiumize.me/api/transfer/create?type=torrent', {
		formData: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			src: fs.createReadStream( filename )
		}
	}, premiumize_handler );
}

if ( cmd.torrent_url ) {
	console.log( 'torrent urls:', cmd.torrent_url );
	queue_torrent_url( cmd.torrent_url );
}


if ( cmd.torrent_file ) {
	console.log( 'torrent files:', cmd.torrent_file );
	queue_torrent_file( cmd.torrent_file );
}