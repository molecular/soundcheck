#!/usr/bin/env node

var cmd = require('commander');
var config = require('./config');
var request = require('request');
var fs = require('fs');
var _ = require('lodash');

cmd
  .version('0.1.0')
  .option('-t, --torrent <url>', 'Download Torrent')
  .option('-P, --pineapple', 'Add pineapple')
  .option('-b, --bbq-sauce', 'Add bbq sauce')
  .option('-c, --cheese [type]', 'Add the specified type of cheese [marble]', 'marble')
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

var queue_torrent = function( url ) {
	
	// request torrent file content
	request
		.get( url )
		.on( 'response', ( response ) => {
			console.log("torrent file response.body: ", response.body );
		});

	// create transfer at premiumize.me using torrent file content
	request.post( 'https://www.premiumize.me/api/transfer/create?type=torrent', {
		formData: {
			customer_id: config.premiumize.customer_id,
			pin: config.premiumize.pin,
			src: fs.createReadStream( './test.torrent' )
		}
	}, premiumize_handler );
}

if (cmd.torrent) {
	console.log( 'torrents:', cmd.torrent );
	queue_torrent( cmd.torrent );
}


