import webpackHotMiddleware from "webpack-hot-middleware"
import webpackDevMiddleware, {
  WebpackDevMiddleware,
} from "webpack-dev-middleware"
import got from "got"
import webpack from "webpack"
import express from "express"
import graphqlHTTP from "express-graphql"
import graphqlPlayground from "graphql-playground-middleware-express"
import graphiqlExplorer from "gatsby-graphiql-explorer"
import { formatError } from "graphql"
import path from "path"
import fs from "fs"
import { codeFrameColumns } from "@babel/code-frame"
import ansiHTML from "ansi-html"

import webpackConfig from "../utils/webpack.config"
import { store, emitter } from "../redux"
import { buildRenderer } from "../commands/build-html"
// import { withBasePath } from "../utils/path"
import report from "gatsby-cli/lib/reporter"
import launchEditor from "react-dev-utils/launchEditor"
import cors from "cors"
import telemetry from "gatsby-telemetry"
import * as WorkerPool from "../utils/worker/pool"
import { renderHTML } from "../utils/worker/render-html"
import http from "http"
import https from "https"

import { developStatic } from "../commands/develop-static"
import withResolverContext from "../schema/context"
import { websocketManager, WebsocketManager } from "../utils/websocket-manager"
import apiRunnerNode from "../utils/api-runner-node"
import { Express } from "express"

import { Stage, IProgram } from "../commands/types"
import JestWorker from "jest-worker"

type ActivityTracker = any // TODO: Replace this with proper type once reporter is typed

interface IServer {
  compiler: webpack.Compiler
  listener: http.Server | https.Server
  webpackActivity: ActivityTracker
  websocketManager: WebsocketManager
  workerPool: JestWorker
  webpackWatching: IWebpackWatchingPauseResume
}

export interface IWebpackWatchingPauseResume extends webpack.Watching {
  suspend: () => void
  resume: () => void
}

// context seems to be public, but not documented API
// see https://github.com/webpack/webpack-dev-middleware/issues/656
type PatchedWebpackDevMiddleware = WebpackDevMiddleware &
  express.RequestHandler & {
    context: {
      watching: IWebpackWatchingPauseResume
    }
  }

export async function startServer(
  program: IProgram,
  app: Express,
  workerPool: JestWorker = WorkerPool.create()
): Promise<IServer> {
  const directory = program.directory

  const webpackActivity = report.activityTimer(`Building development bundle`, {
    id: `webpack-develop`,
  })
  webpackActivity.start()

  const devConfig = await webpackConfig(
    program,
    directory,
    `develop`,
    program.port,
    { parentSpan: webpackActivity.span }
  )

  await buildRenderer(program, Stage.DevelopHTML)

  const compiler = webpack(devConfig)

  /**
   * Set up the express app.
   **/
  app.use(telemetry.expressMiddleware(`DEVELOP`))
  app.use(
    webpackHotMiddleware(compiler, {
      log: false,
      path: `/__webpack_hmr`,
      heartbeat: 10 * 1000,
    })
  )

  app.use(cors())

  /**
   * Pattern matching all endpoints with graphql or graphiql with 1 or more leading underscores
   */
  const graphqlEndpoint = `/_+graphi?ql`

  if (process.env.GATSBY_GRAPHQL_IDE === `playground`) {
    app.get(
      graphqlEndpoint,
      graphqlPlayground({
        endpoint: `/___graphql`,
      }),
      () => {}
    )
  } else {
    graphiqlExplorer(app, {
      graphqlEndpoint,
    })
  }

  app.use(
    graphqlEndpoint,
    graphqlHTTP(
      (): graphqlHTTP.OptionsData => {
        const { schema, schemaCustomization } = store.getState()

        if (!schemaCustomization.composer) {
          throw new Error(
            `A schema composer was not created in time. This is likely a gatsby bug. If you experienced this please create an issue.`
          )
        }
        return {
          schema,
          graphiql: false,
          extensions(): { [key: string]: unknown } {
            return {
              enableRefresh: process.env.ENABLE_GATSBY_REFRESH_ENDPOINT,
              refreshToken: process.env.GATSBY_REFRESH_TOKEN,
            }
          },
          context: withResolverContext({
            schema,
            schemaComposer: schemaCustomization.composer,
            context: {},
            customContext: schemaCustomization.context,
          }),
          customFormatErrorFn(err): unknown {
            return {
              ...formatError(err),
              stack: err.stack ? err.stack.split(`\n`) : [],
            }
          },
        }
      }
    )
  )

  /**
   * Refresh external data sources.
   * This behavior is disabled by default, but the ENABLE_GATSBY_REFRESH_ENDPOINT env var enables it
   * If no GATSBY_REFRESH_TOKEN env var is available, then no Authorization header is required
   **/
  const REFRESH_ENDPOINT = `/__refresh`
  const refresh = async (req: express.Request): Promise<void> => {
    emitter.emit(`WEBHOOK_RECEIVED`, {
      webhookBody: req.body,
    })
  }
  app.use(REFRESH_ENDPOINT, express.json())
  app.post(REFRESH_ENDPOINT, (req, res) => {
    const enableRefresh = process.env.ENABLE_GATSBY_REFRESH_ENDPOINT
    const refreshToken = process.env.GATSBY_REFRESH_TOKEN
    const authorizedRefresh =
      !refreshToken || req.headers.authorization === refreshToken

    if (enableRefresh && authorizedRefresh) {
      refresh(req)
    }
    res.end()
  })

  app.get(`/__open-stack-frame-in-editor`, (req, res) => {
    launchEditor(req.query.fileName, req.query.lineNumber)
    res.end()
  })

  const webpackDevMiddlewareInstance = (webpackDevMiddleware(compiler, {
    logLevel: `silent`,
    publicPath: devConfig.output.publicPath,
    watchOptions: devConfig.devServer ? devConfig.devServer.watchOptions : null,
    stats: `errors-only`,
  }) as unknown) as PatchedWebpackDevMiddleware

  app.use(webpackDevMiddlewareInstance)

  // Expose access to app for advanced use cases
  const { developMiddleware } = store.getState().config

  if (developMiddleware) {
    developMiddleware(app, program)
  }

  // Set up API proxy.
  const { proxy } = store.getState().config
  if (proxy) {
    proxy.forEach(({ prefix, url }) => {
      app.use(`${prefix}/*`, (req, res) => {
        const proxiedUrl = url + req.originalUrl
        const {
          // remove `host` from copied headers
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          headers: { host, ...headers },
          method,
        } = req
        req
          .pipe(
            got
              .stream(proxiedUrl, { headers, method, decompress: false })
              .on(`response`, response =>
                res.writeHead(response.statusCode || 200, response.headers)
              )
              .on(`error`, (err, _, response) => {
                if (response) {
                  res.writeHead(response.statusCode || 400, response.headers)
                } else {
                  const message = `Error when trying to proxy request "${req.originalUrl}" to "${proxiedUrl}"`

                  report.error(message, err)
                  res.sendStatus(500)
                }
              })
          )
          .pipe(res)
      })
    }, cors())
  }

  await apiRunnerNode(`onCreateDevServer`, { app, deferNodeMutation: true })

  // In case nothing before handled hot-update - send 404.
  // This fixes "Unexpected token < in JSON at position 0" runtime
  // errors after restarting development server and
  // cause automatic hard refresh in the browser.
  app.use(/.*\.hot-update\.json$/i, (_, res) => {
    res.status(404).end()
  })

  // const buildRendererActivity = report.activityTimer(
  //   `Building renderer bundle`,
  //   {
  //     id: `webpack-renderer`,
  //   }
  // )
  const getPosition = function (stackObject) {
    var filename, line, row
    // Because the JavaScript error stack has not yet been standardized,
    // wrap the stack parsing in a try/catch for a soft fail if an
    // unexpected stack is encountered.
    try {
      var filteredStack = stackObject.filter(function (s) {
        return /\(.+?\)$/.test(s)
      })
      var splitLine
      // For current Node & Chromium Error stacks
      if (filteredStack.length > 0) {
        splitLine = filteredStack[0].match(/(?:\()(.+?)(?:\))$/)[1].split(":")
        // For older, future, or otherwise unexpected stacks
      } else {
        splitLine = stackObject[0].split(":")
      }
      var splitLength = splitLine.length
      filename = splitLine[splitLength - 3]
      line = Number(splitLine[splitLength - 2])
      row = Number(splitLine[splitLength - 1])
    } catch (err) {
      filename = ""
      line = 0
      row = 0
    }
    return {
      filename: filename,
      line: line,
      row: row,
    }
  }
  const parseError = function (err) {
    var stack = err.stack ? err.stack : ""
    var stackObject = stack.split("\n")
    var position = getPosition(stackObject)
    // Remove the `/lib/` added by webpack
    var filename = path.join(
      directory,
      ...position.filename.split(path.sep).slice(2)
    )
    var code = require(`fs`).readFileSync(filename, `utf-8`)
    var line = position.line
    var row = position.row
    ansiHTML.setColors({
      reset: ["555", "fff"], // FOREGROUND-COLOR or [FOREGROUND-COLOR] or [, BACKGROUND-COLOR] or [FOREGROUND-COLOR, BACKGROUND-COLOR]
      black: "aaa", // String
      red: "bbb",
      green: "ccc",
      yellow: "ddd",
      blue: "eee",
      magenta: "fff",
      cyan: "999",
      lightgrey: "888",
      darkgrey: "777",
    })
    var codeFrame = ansiHTML(
      codeFrameColumns(
        code,
        {
          start: { line: row, column: line },
        },
        { forceColor: true }
      )
    )
    var splitMessage = err.message ? err.message.split("\n") : [""]
    var message = splitMessage[splitMessage.length - 1]
    var type = err.type ? err.type : err.name
    var data = {
      filename: filename,
      code,
      codeFrame,
      line: line,
      row: row,
      message: message,
      type: type,
      stack: stack,
      arguments: err.arguments,
    }
    return data
  }

  // Render an HTML page and serve it.
  app.use(async (req, res, next) => {
    const { pages } = store.getState()

    if (!pages.has(req.path)) {
      return next()
    }

    const htmlActivity = report.activityTimer(
      `building HTML for path "${req.path}"`,
      {}
    )
    htmlActivity.start()

    let response = `error`
    try {
      let renderResponse = await renderHTML({
        htmlComponentRendererPath: `${program.directory}/public/render-page.js`,
        paths: [req.path],
        envVars: [
          [`NODE_ENV`, process.env.NODE_ENV || ``],
          [
            `gatsby_executing_command`,
            process.env.gatsby_executing_command || ``,
          ],
          [`gatsby_log_level`, process.env.gatsby_log_level || ``],
        ],
      })
      response = renderResponse[0]
      res.status(200).send(response)
    } catch (e) {
      let error = parseError(e)
      console.log(error)
      res.status(500).send(`<h1>Error<h1>
        <h2>The page didn't SSR correctly</h2>
        <ul>
          <li><strong>URL path:</strong> ${req.path}</li>
          <li><strong>File path:</strong> ${error.filename}</li>
        </ul>
        <h3>error message</h3>
        <p><code>${error.message}</code></p>
        <pre>${error.codeFrame}</pre>`)
    }

    // TODO add support for 404 and general rendering errors
    htmlActivity.end()
  })

  // Disable directory indexing i.e. serving index.html from a directory.
  // This can lead to serving stale html files during development.
  //
  // We serve by default an empty index.html that sets up the dev environment.
  app.use(developStatic(`public`, { index: false }))

  /**
   * Set up the HTTP server and socket.io.
   **/
  const server = new http.Server(app)

  const socket = websocketManager.init({ server, directory: program.directory })

  // hardcoded `localhost`, because host should match `target` we set
  // in http proxy in `develop-proxy`
  const listener = server.listen(program.port, `localhost`)

  // Register watcher that rebuilds index.html every time html.js changes.
  // const watchGlobs = [`src/html.js`, `plugins/**/gatsby-ssr.js`].map(path =>
  //   slash(directoryPath(path))
  // )

  // chokidar.watch(watchGlobs).on(`change`, async () => {
  //   // console.log(`Time to build a renderer`)
  //   // await buildRenderer(program, Stage.DevelopHTML, webpackActivity)
  //   // console.log(`We built a renderer`)
  //   // eslint-disable-next-line no-unused-expressions
  //   socket?.to(`clients`).emit(`reload`)
  // })

  return {
    compiler,
    listener,
    webpackActivity,
    websocketManager,
    workerPool,
    webpackWatching: webpackDevMiddlewareInstance.context.watching,
  }
}
