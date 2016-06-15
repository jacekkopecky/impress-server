/*jshint esversion: 6 */
const localEnvironment = process.env.HOME === '/Users/jacek';

module.exports = {
  provideIndex: localEnvironment, // if true, the server will serve index for any directory, which we don't want on the real server
  staticCacheTime: localEnvironment ? 0 : 5*60*1000, // five minutes
  https: !localEnvironment,
  httpsCert: "/etc/letsencrypt/live/jacek.soc.port.ac.uk/fullchain.pem",
  httpsKey: "/etc/letsencrypt/live/jacek.soc.port.ac.uk/privkey.pem",
};
