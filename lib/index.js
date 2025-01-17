'use strict';

const Http = require('http');
const Https = require('https');

const Hoek = require('@hapi/hoek');
const Validate = require('@hapi/validate');
const Wreck = require('@mocko/wreck');

const debug = require('debug')('mocko:h2o2:main');

const internals = {
    NS_PER_SEC: 1e9
};


internals.defaults = {
    httpClient: {
        request: Wreck.request.bind(Wreck),
        parseCacheControl: Wreck.parseCacheControl.bind(Wreck)
    },
    xforward: false,
    passThrough: false,
    proxyHost: false,
    redirects: false,
    timeout: 1000 * 60 * 3, // Timeout request after 3 minutes
    connectTimeout: 1000 * 3,   // Timeout connection after 3 seconds
    localStatePassThrough: false,   // Pass cookies defined by the server upstream
    maxSockets: Infinity,
    downstreamResponseTime: false
};


internals.schema = Validate.object({
    httpClient: Validate.object({
        request: Validate.func(),
        parseCacheControl: Validate.func()
    }),
    host: Validate.string(),
    port: Validate.number().integer(),
    protocol: Validate.string().valid('http', 'https', 'http:', 'https:'),
    uri: Validate.string(),
    passThrough: Validate.boolean(),
    proxyHost: Validate.boolean(),
    localStatePassThrough: Validate.boolean(),
    acceptEncoding: Validate.boolean().when('passThrough', { is: true, otherwise: Validate.forbidden() }),
    rejectUnauthorized: Validate.boolean(),
    xforward: Validate.boolean(),
    redirects: Validate.number().min(0).integer().allow(false),
    timeout: Validate.number().integer(),
    connectTimeout: Validate.number().integer(),
    mapUri: Validate.func(),
    onResponse: Validate.func(),
    onRequest: Validate.func(),
    agent: Validate.object(),
    ttl: Validate.string().valid('upstream').allow(null),
    maxSockets: Validate.number().positive().allow(false),
    secureProtocol: Validate.string(),
    ciphers: Validate.string(),
    downstreamResponseTime: Validate.boolean()
})
    .xor('host', 'mapUri', 'uri')
    .without('mapUri', 'port')
    .without('mapUri', 'protocol')
    .without('uri', 'port')
    .without('uri', 'protocol');


exports.plugin = {
    pkg: require('../package.json'),
    requirements: {
        hapi: '>=19.0.0'
    },

    register: function (server, options) {

        internals.defaults = Hoek.applyToDefaults(internals.defaults, options);

        server.expose('_agents', new Map());                        // server.info.uri -> { http, https, insecure }
        server.decorate('handler', 'proxy', internals.handler);
        server.decorate('toolkit', 'proxy', internals.toolkit);
    }
};


internals.handler = function (route, handlerOptions) {

    const settings = Hoek.applyToDefaults(internals.defaults, handlerOptions, { shallow: ['agent'] });
    Validate.assert(handlerOptions, internals.schema, 'Invalid proxy handler options (' + route.path + ')');
    settings.mapUri = handlerOptions.mapUri || internals.mapUri(handlerOptions.protocol, handlerOptions.host, handlerOptions.port, handlerOptions.uri);

    if (settings.ttl === 'upstream') {
        settings._upstreamTtl = true;
    }

    return async function (request, h) {

        debug('mapping uri');
        const { uri, headers } = await settings.mapUri(request);

        const protocol = uri.split(':', 1)[0];

        const options = {
            headers: {},
            payload: request.payload,
            redirects: settings.redirects,
            timeout: settings.timeout,
            connectTimeout: settings.connectTimeout,
            agent: internals.agent(protocol, settings, request)
        };

        const bind = request.route.settings.bind;

        debug('processing headers');
        if (settings.passThrough) {
            options.headers = Hoek.clone(request.headers);
            delete options.headers.host;
            delete options.headers['content-length'];

            if (settings.acceptEncoding === false) { // Defaults to true
                delete options.headers['accept-encoding'];
            }

            if (options.headers.cookie) {
                delete options.headers.cookie;

                const cookieHeader = request.server.states.passThrough(request.headers.cookie, settings.localStatePassThrough);
                if (cookieHeader) {
                    if (typeof cookieHeader !== 'string') {
                        throw cookieHeader; // Error
                    }

                    options.headers.cookie = cookieHeader;
                }
            }
        }

        if (headers) {
            Hoek.merge(options.headers, headers);
        }

        if (settings.proxyHost) {
            options.headers.host = request.headers.host;
        }

        if (settings.xforward &&
            request.info.remotePort) {

            options.headers['x-forwarded-for'] = (options.headers['x-forwarded-for'] ? options.headers['x-forwarded-for'] + ',' : '') + request.info.remoteAddress;
            options.headers['x-forwarded-port'] = options.headers['x-forwarded-port'] || request.info.remotePort;
            options.headers['x-forwarded-proto'] = options.headers['x-forwarded-proto'] || request.server.info.protocol;
            options.headers['x-forwarded-host'] = options.headers['x-forwarded-host'] || request.info.host;
        }

        if (settings.ciphers) {
            options.ciphers = settings.ciphers;
        }

        if (settings.secureProtocol) {
            options.secureProtocol = settings.secureProtocol;
        }

        const contentType = request.headers['content-type'];
        if (contentType) {
            options.headers['content-type'] = contentType;
        }

        let ttl = null;

        let downstreamStartTime;
        if (settings.downstreamResponseTime) {
            downstreamStartTime = process.hrtime();
        }

        debug('sending request');
        const promise = settings.httpClient.request(request.method, uri, options);

        if (settings.onRequest) {
            settings.onRequest(promise.req);
        }

        try {
            var res = await promise;
            debug('got response');
            if (settings.downstreamResponseTime) {
                const downstreamResponseTime = process.hrtime(downstreamStartTime);
                request.log(['h2o2', 'success'], { downstreamResponseTime: downstreamResponseTime[0] * internals.NS_PER_SEC + downstreamResponseTime[1] });
            }
        }
        catch (err) {
            debug('got response error');
            if (settings.downstreamResponseTime) {
                const downstreamResponseTime = process.hrtime(downstreamStartTime);
                request.log(['h2o2', 'error'], { downstreamResponseTime: downstreamResponseTime[0] * internals.NS_PER_SEC + downstreamResponseTime[1] });
            }

            if (settings.onResponse) {
                return settings.onResponse.call(bind, err, res, request, h, settings, ttl);
            }

            throw err;
        }

        if (settings._upstreamTtl) {
            const cacheControlHeader = res.headers['cache-control'];
            if (cacheControlHeader) {
                const cacheControl = settings.httpClient.parseCacheControl(cacheControlHeader);
                if (cacheControl) {
                    ttl = cacheControl['max-age'] * 1000;
                }
            }
        }

        if (settings.onResponse) {
            return settings.onResponse.call(bind, null, res, request, h, settings, ttl);
        }

        return h.response(res)
            .ttl(ttl)
            .code(res.statusCode)
            .passThrough(!!settings.passThrough);

    };
};


internals.handler.defaults = function (method) {

    const payload = method !== 'get' && method !== 'head';
    return payload ? {
        payload: {
            output: 'stream',
            parse: false
        }
    } : null;
};


internals.toolkit = function (options) {

    return internals.handler(this.request.route, options)(this.request, this);
};


internals.mapUri = function (protocol, host, port, uri) {

    if (uri) {
        return function (request) {

            if (uri.indexOf('{') === -1) {
                return { uri };
            }

            let address = uri.replace(/{protocol}/g, request.server.info.protocol)
                .replace(/{host}/g, request.server.info.host)
                .replace(/{port}/g, request.server.info.port)
                .replace(/{path}/g, request.path);

            Object.keys(request.params).forEach((key) => {

                const re = new RegExp(`{${key}}`, 'g');
                address = address.replace(re, request.params[key]);
            });

            return {
                uri: address
            };
        };
    }

    if (protocol &&
        protocol[protocol.length - 1] !== ':') {

        protocol += ':';
    }

    protocol = protocol || 'http:';

    port = port || (protocol === 'http:' ? 80 : 443);
    const baseUrl = protocol + '//' + host + ':' + port;

    return function (request) {

        return {
            uri: (null, baseUrl + request.path + (request.url.search || ''))
        };
    };
};


internals.agent = function (protocol, settings, request) {

    if (settings.agent) {
        return settings.agent;
    }

    if (settings.maxSockets === false) {
        return undefined;
    }

    const store = request.server.plugins.h2o2._agents;
    if (!store.has(request.info.uri)) {
        store.set(request.info.uri, {});
    }

    const agents = store.get(request.info.uri);

    const type = (protocol === 'http' ? 'http' : (settings.rejectUnauthorized === false ? 'insecure' : 'https'));
    if (!agents[type]) {
        agents[type] = (type === 'http' ? new Http.Agent() : (type === 'https' ? new Https.Agent() : new Https.Agent({ rejectUnauthorized: false })));
        agents[type].maxSockets = settings.maxSockets;
    }

    return agents[type];
};
