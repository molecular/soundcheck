#!/usr/bin/env node

var cmd = require('commander');
var config = require('./config');

cmd
  .version('0.1.0')
  .option('-t, --torrent <url>', 'Download Torrent')
  .option('-P, --pineapple', 'Add pineapple')
  .option('-b, --bbq-sauce', 'Add bbq sauce')
  .option('-c, --cheese [type]', 'Add the specified type of cheese [marble]', 'marble')
  .parse(process.argv);

if (cmd.torrent) {
	console.log( 'torrents:', cmd.torrent );
}

console.log( "config: ", config );

