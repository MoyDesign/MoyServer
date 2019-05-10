const { TextDecoder } = require('util')
const { URL } = require('url')

const polka = require('polka')
const fetch = require('node-fetch')
const jsdom = require('jsdom')
const Handlebars = require('handlebars')
const jsyaml = require('js-yaml')

const MoyParser = require('./moyparser')
const MoyTemplate = require('./moytemplate')

const PARSERS_DIR = 'MoyParsers'
const TEMPLATES_DIR = 'MoyTemplates'
const ORIGINAL_LOOK_NAME = 'Original look'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const REFRESH_INTERVAL = 5 * HOUR
const CHECK_INTERVAL = 5 * MINUTE

const CHARSET_RGX = /charset=([^()<>@,;:\"/[\]?.=\s]*)/i

const { JSDOM } = jsdom
const virtualDom = new JSDOM('')
const jQuery = require('jquery')(virtualDom.window)

const DEFAULT_SETTINGS = {
    githubUser: 'MoyDesign',
    port: 3000,
    defaultUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.131 Safari/537.36',
    defaultContentType: 'text/html; charset=utf-8'
}

let settings = {
    githubUser: process.env.GITHUB_USER || DEFAULT_SETTINGS.githubUser,
    port: process.env.PORT || DEFAULT_SETTINGS.port,
    defaultUserAgent: process.env.DEFAULT_USER_AGENT || DEFAULT_SETTINGS.defaultUserAgent,
    defaultContentType: process.env.DEFAULT_CONTENT_TYPE || DEFAULT_SETTINGS.defaultContentType,
}

let state = {
    parsers: new Map(),
    templates: new Map(),
    lastRefresh: 0,
    refreshDataPromise: null,
    lastRefreshError: null
}

function createParser(options) {
    const {text, link, local} = options
    return new MoyParser({content: jsyaml.safeLoad(text), text: text, link: link, local: !!local,
        jQuery: jQuery, document: virtualDom.window.document})
}

function createTemplate(options) {
    const {text, link, local} = options
    return new MoyTemplate({content: text, parseYaml: jsyaml.safeLoad, text: text, link: link, local: !!local,
        Handlebars: Handlebars})
}

function extractCharset(contentType) {
    return contentType && CHARSET_RGX.test(contentType) ? CHARSET_RGX.exec(contentType)[1].toLowerCase() : 'utf-8'
}

async function getFetchedText(resp) {
    const charset = extractCharset(resp.headers.get('content-type') || '')
    const arrayBuffer = await resp.arrayBuffer()
    return new TextDecoder(charset).decode(arrayBuffer)
}

async function fetchFile(githubFileInfo) {
    const resp = await fetch(githubFileInfo.download_url, {
        headers: {
            'User-Agent': githubFileInfo.user_agent || settings.defaultUserAgent
        }
    })
    if (!resp.ok) {
        throw new Error(`${resp.statusText}: ${githubFileInfo.download_url}`)
    }
    return {
        link: githubFileInfo.html_url,
        text: await getFetchedText(resp),
        headers: resp.headers
    }
}

function githubDirUrl(dirname) {
    const user = settings.githubUser || DEFAULT_SETTINGS.githubUser
    return `https://api.github.com/repos/${user}/MoyData/contents/${dirname}`
}

async function fetchDir(dirname) {
    const url = githubDirUrl(dirname)
    const resp = await fetch(url)
    if (!resp.ok) {
        throw new Error(`${resp.statusText}: ${url}`)
    }
    return await resp.json()
}

async function fetchParser(githubFileInfo) {
    return createParser(await fetchFile(githubFileInfo))
}

async function fetchTemplate(githubFileInfo) {
    return createTemplate(await fetchFile(githubFileInfo))
}

async function allPossible(promises) {
    return Promise.all(promises.map(p => p.catch(e => e)))
}

async function fetchMap(dirname, fileFetcher, entityFilter) {
    const dir = await fetchDir(dirname)
    let entities = await allPossible(dir.map(fileFetcher))
    let ok = entities.filter(e => !(e instanceof Error))
    let err = entities.filter(e => e instanceof Error)
    if (entityFilter) {
        ok = ok.filter(entityFilter)
    }
    return {ok: new Map(ok.map(e => [e.name, e])), error: err}
}

function templateFilter(template) {
    return ORIGINAL_LOOK_NAME !== template.name.trim()
}

function refreshData() {
    if (!state.refreshDataPromise) {
        state.refreshDataPromise = Promise.all([
                fetchMap(PARSERS_DIR, fetchParser),
                fetchMap(TEMPLATES_DIR, fetchTemplate, templateFilter)
            ])
            .then(res => {
                state.parsers = res[0].ok
                state.templates = res[1].ok
                if (res[0].error.length > 0 || res[1].error.length > 0) {
                    throw new Error(res[0].error.map(e => e.message).join('\n') + '\n' + 
                        res[1].error.map(e => e.message).join('\n'))
                } else {
                    state.lastRefreshError = null
                    console.log(`Updated data, got ${state.parsers.size} parsers and ${state.templates.size} templates`)
                }
            })
            .catch(e => {
                console.log('Error while refreshing data', e)
                state.lastRefreshError = e
            })
            .finally(() => {
                state.lastRefresh = Date.now()
                state.refreshDataPromise = null
            })
    }
    return state.refreshDataPromise
}

function periodicDataRefresh() {
    if (REFRESH_INTERVAL < Date.now() - state.lastRefresh) {
        refreshData().catch(e => concole.log('Data refresh failed', e))
    }
    setTimeout(periodicDataRefresh, CHECK_INTERVAL)
}

function findValue(mapArray, predicate) {
    for (const aMap of mapArray) {
        for (const v of aMap.values()) {
            if (predicate(v)) {
                return v
            }
        }
    }
}

function getValue(mapArray, key) {
    for (const aMap of mapArray) {
        const ret = aMap.get(key)
        if (ret) {
            return ret
        }
    }
}

function findParser(url) {
    return url && findValue([state.parsers], p => p.isMatch(url))
}

function customArrayToString() {
    return this.join(' ')
}

function isObject(v) {
    return v === Object(v)
}

function polishToken(token) {
    if (Array.isArray(token)) {
        token.toString = customArrayToString
        token.forEach(polishToken)
    }
    if (isObject(token)) {
        Object.values(token).forEach(polishToken)
    }
    return token
}

async function render(req, res) {
    try {
        let {url, template: templateName} = req.query
        const template = state.templates.get(templateName)
        if (!template) {
            res.statusCode = 404
            res.end(`Template ${templateName} not found`)
            return
        }
        const parser = findParser(url)
        if (!parser) {
            res.statusCode = 404
            res.end(`No matching parsers for ${url}`)
            return
        }
        url = parser.getRedirectUrl(url) || url
        const {text: webData, headers} = await fetchFile({
            download_url: url,
            user_agent: req.headers['user-agent']
        })
        const dom = new JSDOM(webData)
        const realParserOptions = Object.assign({}, parser.options)
        realParserOptions.jQuery = require('jquery')(dom.window)
        realParserOptions.document = dom.window.document
        const realParser = new MoyParser(realParserOptions)
        const parsedData = realParser.parse()
        const tokens = {
            BASE_URL: [new URL(url).origin],
            FULL_URL: [url]
        }
        for (const [name, value] of parsedData.content) {
            tokens[name] = polishToken(value)
        }
        var compiledTemplateSpec
        eval('compiledTemplateSpec = ' + template.precompiled)
        res.writeHead(200, { 'Content-Type': settings.defaultContentType });
        res.end(Handlebars.template(compiledTemplateSpec)(tokens))
    } catch (e) {
        console.log('Failed to render', e)
        res.statusCode = 500
        res.end('' + e)
    }
}

polka()
    .get('/render', render)
    .listen(settings.port, err => {
        if (err) throw err
        console.log(`> Running on localhost:3000`)
        periodicDataRefresh()
    })
