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

const { JSDOM } = jsdom
const virtualDom = new JSDOM('')
const jQuery = require('jquery')(virtualDom.window)

const DEFAULT_SETTINGS = {
    githubUser: 'MoyDesign',
    port: 3000
}

let settings = {
    githubUser: process.env.GITHUB_USER || DEFAULT_SETTINGS.githubUser,
    port: process.env.PORT || DEFAULT_SETTINGS.port
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

async function fetchFile(githubFileInfo) {
    const resp = await fetch(githubFileInfo.download_url)
    if (!resp.ok) {
        throw new Error(`${resp.statusText}: ${githubFileInfo.download_url}`)
    }
    return {
        link: githubFileInfo.html_url,
        text: await resp.text()
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

async function refreshData() {
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
                throw e
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
        refreshData()
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
        const {text: webData} = await fetchFile({download_url: url})
        const dom = new JSDOM(webData)
        const realParserOptions = Object.assign({}, parser.options)
        realParserOptions.jQuery = require('jquery')(dom.window)
        realParserOptions.document = dom.window.document
        const realParser = new MoyParser(realParserOptions)
        const parsedData = realParser.parse()
        res.end(JSON.stringify([...parsedData.content]))
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
