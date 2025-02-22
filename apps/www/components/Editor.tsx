/* eslint-disable react-hooks/exhaustive-deps */
import {
  ColorStyle,
  PagePartial,
  Patch,
  TDExport,
  TDExportType,
  TDPage,
  TDShape,
  TDShapeType,
  Tldraw,
  TldrawApp,
  TldrawPatch,
  TldrawProps,
  VersionNodeShape,
} from '@tldraw/tldraw'
import AsyncLock from 'async-lock'
import axios from 'axios'
import { Simulation, SimulationNodeDatum } from 'd3'
import * as lodash from 'lodash'
//import { useUploadAssets } from 'hooks/useUploadAssets'
import React from 'react'
import {
  connectWebSocket,
  exportByColor,
  getStudyConsent, //updateCurrentVersion,
  loadFileFromProcessing,
  postStudyConsent,
  saveToProcessing,
  sendToLog,
  sendToUsageData,
  sendUsageData,
  updateSocketVersions,
  updateThumbnail,
  updateVersions,
  useUploadAssets,
} from 'utils/quickPoseNetworking'
import {
  EditorProps,
  forceLink,
  quickPoseFile,
  studyConsentPreference,
  studyConsentResponse,
} from 'utils/quickPoseTypes'
import {
  d3Sim,
  defaultSticky,
  graphBaseData,
  installHelper,
  linkRegex,
  loadTldrFile,
  nodeRegex,
  updateGraphData,
  updateLinkShapes,
  updateLoadingTicks,
  updateNodeShapes,
} from 'utils/quickposeDrawing'
// import * as gtag from 'utils/gtag'
import { w3cwebsocket as W3CWebSocket } from 'websocket'
import { BetaNotification } from './BetaNotification'
import { StudyConsentPopup } from './StudyConsentPopup'

//declare const window: Window & { app: TldrawApp }

export const D3_LINK_DISTANCE = 4
export const TL_DRAW_RADIUS = 45
export const ALPHA_TARGET_REFRESH = 0.1
const LOCALHOST_BASE = 'http://127.0.0.1:8080'
export const d3TlScale = 5

const Editor = ({ id = 'home', ...rest }: EditorProps & Partial<TldrawProps>) => {
  const rTldrawApp = React.useRef<TldrawApp>()

  //selection/dragging
  const rIsDragging = React.useRef(false)
  const lastSelection = React.useRef<string | null>(null)
  const currentVersion = React.useRef<number | null>(null)
  const timeSinceLastSelection = React.useRef<number>(0)
  const timeSinceLastFork = React.useRef<number>(0)
  const centerPoint = React.useRef<[number, number]>([600, 600])

  const timeSinceLastSave = React.useRef<number>(0)
  const timeSinceLastUsageLog = React.useRef<number>(0)
  //file loading
  const loadFile = React.useRef<quickPoseFile | null>(null)
  const loadedFile = React.useRef<boolean>(false)

  const thumbnailSocket = React.useRef<W3CWebSocket | null>(null)
  // eslint-disable-next-line prefer-const
  let socketState = { status: W3CWebSocket.CLOSED }
  const connectInterval = React.useRef<any>(null)
  //d3 sim
  const simulation = React.useRef<d3.Simulation<SimulationNodeDatum, undefined> | undefined>()

  //data structs
  const netData = React.useRef<any>(undefined)
  const graphData = React.useRef<{ nodes: any[]; links: any[] }>(graphBaseData)
  const loadingTicks = React.useRef<number>(0) //Counter for sticky loading dots

  const networkIntervalRef = React.useRef<any>(null)

  const [showStudyConsent, setShowStudyConsent] = React.useState<Boolean>(false)
  const checkSettings = React.useRef<Boolean>(false)
  const userID = React.useRef<string>('')
  const projectID = React.useRef<string>('')
  const stopCheckConsent = React.useRef<Boolean>(false)
  function setStudyPreferenceFromInterface(pref: studyConsentResponse) {
    stopCheckConsent.current = true
    setShowStudyConsent(false)
    console.log('setfrominterface', pref)
    rTldrawApp.current?.setSetting('sendUsageData', pref.preference)
    if (pref.preference == 'Enabled') {
      postStudyConsent('Enabled', pref.promptAgain ? 'True' : 'False')
    } else if (pref.preference == 'Disabled') {
      postStudyConsent('Disabled', pref.promptAgain ? 'True' : 'False')
    }
  }
  function setStudyPreferenceFromProject(pref: studyConsentResponse) {
    console.log('setfromproject', pref)
    if (stopCheckConsent.current == false) {
      if (pref.promptAgain) {
        setShowStudyConsent(true)
      } else {
        setShowStudyConsent(false)
        stopCheckConsent.current = true
      }
      rTldrawApp.current?.setSetting('sendUsageData', pref.preference)
    }
  }
  function setStudyPreferenceFromSettings(pref: studyConsentResponse) {
    if (checkSettings.current == false && stopCheckConsent.current == false) {
      console.log('setfromsettings', pref)
      if (pref.promptAgain) {
        setShowStudyConsent(true)
      } else {
        setShowStudyConsent(false)
        stopCheckConsent.current = true
      }
      rTldrawApp.current?.setSetting('sendUsageData', pref.preference)
      checkSettings.current = true
    }
  }
  let abortFileController = new AbortController()
  const timeout = 2000
  const lock = new AsyncLock()

  function refreshSim(
    simulation: React.MutableRefObject<Simulation<SimulationNodeDatum, undefined> | undefined>
  ) {
    const app = rTldrawApp.current!
    if (simulation.current !== undefined && app) {
      if (app.settings.simulationPause) {
        //console.log(app.settings.simulationPause)
        simulation.current.stop()
      } else {
        //console.log(app.settings.simulationPause)
        simulation.current.restart()
      }
      //simulation.current.alpha(ALPHA_TARGET_REFRESH)
    }
  }
  //const sendFork = (id: string) => throttle(sendForkThrottled(id),2000)

  const sendFork = async (id: string) => {
    //const start = timestampInSeconds()
    const app = rTldrawApp.current!
    if (app !== undefined && app.isLoading === false && currentVersion.current !== undefined) {
      if (id === currentVersion.current.toString()) {
        app.setIsLoading(true)

        //console.log('send fork', id)
        lock
          .acquire('select', async function () {
            await axios
              .get(LOCALHOST_BASE + '/fork/' + id, {
                timeout: 600,
                params: {
                  Autorun: app.settings.sketchAutorun,
                },
              })
              .then((response) => {
                if (response.status === 200) {
                  netData.current = response.data
                  dataInterval(netData, graphData, simulation)
                  app.selectNone()
                  app.setIsLoading(false)
                }
              })
              .catch((error) => {
                console.warn('error forking current version: ', error)
                return null
              })
          })
          .then(function () {
            app.setIsLoading(false)
          })
          .catch((error) => {
            console.warn('error forking current version: ', error)
            return null
          })
      }
    }
  }
  //const sendSelect = (id: string,currentVersion: { current: string; }) => throttle(sendSelectThrottled(id,currentVersion),100)

  const sendSelect = async (id: string) => {
    const app = rTldrawApp.current!
    if (app !== undefined && app.isLoading === false && parseInt(id) !== currentVersion.current) {
      app.setIsLoading(true)
      console.log('send select', id)
      lock
        .acquire('select', async function () {
          await axios
            .get(LOCALHOST_BASE + '/select/' + id, {
              timeout: 600,
              params: {
                Autorun: app.settings.sketchAutorun,
              },
            })
            .then(function (response) {
              if (response.status === 200) {
                //updateThumbnail(app, 'node' + currentVersion.current, currentVersion)
                currentVersion.current = parseInt(response.data)
                app.setIsLoading(false)
                //app.pageState.selectedIds = ['node'+currentVersion.current]
                //drawInterval()
              }
            })
            .catch((error) => {
              console.warn('error selecting current version: ', error)
              return null
            })
        })
        .then(function () {
          app.setIsLoading(false)
        })
    }
  }

  function drawInterval() {
    console.timeStamp('startDraw')

    const sim = simulation.current!
    const app = rTldrawApp.current!
    const gData = graphData.current!
    if (
      sim !== undefined &&
      gData !== undefined &&
      //simulation.current.alpha > simulation.current.alphaMin && //Doesn't work when there's only one node
      loadedFile.current === true &&
      !(app === undefined)
    ) {
      console.timeStamp('preanimframe')
      requestAnimationFrame(() => {
        const currentStyle = app.getAppState().currentStyle
        const content = app.getContent(app.selectedIds)
        let selectedIdsWithGroups = []

        if (content !== undefined && content.shapes !== undefined) {
          selectedIdsWithGroups = content.shapes.map((shape: { id: any }) => shape.id)
        }

        gData.nodes = [...sim.nodes()] //get simulation data out
        const tlNodes = app.getShapes().filter((shape: { id: any }) => nodeRegex.test(shape.id))
        const [nextNodeShapes, createNodeShapes] = updateNodeShapes(
          gData,
          tlNodes,
          currentVersion,
          centerPoint,
          selectedIdsWithGroups,
          app
        )
        const tlLinks = app.getShapes().filter((shape: { id: any }) => linkRegex.test(shape.id))
        const [nextLinkShapes, nextLinkBindings, createLinkShapes] = updateLinkShapes(
          app,
          tlLinks,
          graphData,
          tlNodes,
          simulation
        )

        if (createNodeShapes.length > 0) {
          //console.log("new shapes",createNodeShapes)
          app.patchCreate(createNodeShapes as VersionNodeShape[])
          app.selectNone()
          if (createNodeShapes.length === 1 && app.getShape(createNodeShapes[0].id).point) {
            app.zoomTo(app.zoom, app.getShape(createNodeShapes[0].id).point)
          }
        }
        if (createLinkShapes.length > 0) {
          //console.log("createtllink",createLinkShapes)
          //console.log("tllink",tlLinks)
          const counts = lodash.countBy(createLinkShapes, 'id')
          lodash.filter(createLinkShapes, (shape: { id: string | number }) => counts[shape.id] > 1)
          const uniqueLinks: TDShape[] = lodash.filter(
            createLinkShapes,
            (shape: { id: string | number }) => counts[shape.id] == 1
          )
          for (id in lodash.filter(
            createLinkShapes,
            (shape: { id: string | number }) => counts[shape.id] > 1
          )) {
            uniqueLinks.push(createLinkShapes.find((node: { id: any }) => node.id === id))
          }
          app.patchCreate(createLinkShapes)
          app.selectNone()
        }

        const nextShapes = { ...nextLinkShapes, ...nextNodeShapes } as Patch<TDPage['shapes']>
        const nextBindings = { ...nextLinkBindings } as Patch<TDPage['bindings']>
        const nextPage: PagePartial = {
          shapes: nextShapes,
          bindings: nextBindings,
        }
        sim.nodes(gData.nodes)
        ;(sim.force('link') as forceLink).links(gData.links)
        sim.restart()

        const currentPageId = app.currentPageId
        const patch = {
          document: {
            pages: {
              [currentPageId]: {
                ...nextPage,
              },
            },
          },
        }

        if (Object.keys(nextPage.bindings).length > 0 || Object.keys(nextPage.shapes).length > 0) {
          app.patchState(patch, 'Quickpose Draw Update')
        }
        // const versionNodes = app
        //   .getShapes()
        //   .filter((shape: { id: any }) => nodeRegex.test(shape.id))
        // app.moveToFront(versionNodes.map((node) => node.id))
      })
      console.timeStamp('end animframe')
    }
  }
  //check for new data, if so, update graph data
  function dataInterval(
    netData: React.MutableRefObject<any>,
    graphData: React.MutableRefObject<{ nodes: any[]; links: any[] }>,
    simulation:
      | React.MutableRefObject<d3.Simulation<SimulationNodeDatum, undefined> | undefined>
      | undefined
  ) {
    //console.log(netData.current,graphData.current,simulation.current)
    //https://medium.com/ninjaconcept/interactive-dynamic-force-directed-graphs-with-d3-da720c6d7811
    if (
      netData.current !== undefined &&
      graphData.current !== undefined &&
      simulation &&
      simulation.current !== undefined
    ) {
      if (updateGraphData(netData.current, graphData.current)) {
        currentVersion.current = parseInt(netData.current['CurrentNode'].toString())
      }
      simulation.current.nodes(graphData.current.nodes)
      const forceLink = simulation.current.force('link') as forceLink
      forceLink.links(graphData.current.links)
      refreshSim(simulation)
      drawInterval()
    }
    loadingTicks.current++
  }

  const networkInterval = () => {
    const app = rTldrawApp.current!

    if (!(app === undefined) && thumbnailSocket.current) {
      if (thumbnailSocket.current.readyState === thumbnailSocket.current.OPEN) {
        if (loadedFile.current === false) {
          //still need to handle opening
          //updateVersions(netData, newData)
          if (loadFile.current === null) {
            //haven't found a file yet, so keep looking
            console.log('requesting file...')
            if (checkSettings.current! === false) {
              getStudyConsent(setStudyPreferenceFromSettings)
            }
            thumbnailSocket.current.send('/tldrfile')
            loadFileFromProcessing(loadFile, abortFileController)
            updateLoadingTicks(app, loadingTicks)
            //app.setSetting("keepStyleMenuOpen",false)
          } else if (loadFile.current === undefined) {
            //there is no file, we need to start fresh
            loadedFile.current = true
            app.resetDocument()
            console.log('no file found!')
            abortFileController.abort()
            if (app.getShape('loading')) {
              //remove loading sticky
              app.delete(['loading', 'installHelper1', 'installHelper2', 'installHelper3'])
            }
            centerPoint.current = app.centerPoint as [number, number]
            simulation.current = d3Sim().alpha(3)
            // if(netData.current !== undefined && netData.current !== null && netData.current["ProjectName"]){
            //   app.setCurrentProject(netData.current["ProjectName"])
            // }
            //console.log(netData.current)

            dataInterval(netData, graphData, simulation)
            refreshSim(simulation)
            //app.setSetting("keepStyleMenuOpen",true)
            //simulation.current.alpha(ALPHA_TARGET_REFRESH)
            drawInterval()
            app.zoomToContent()
            //app.setSetting('sendUsageData', 'Prompt')
            //app.appState.isLoading = false
            //make new file, do intro experience?
          } else if (loadFile.current !== null && simulation) {
            //we found an existing file
            abortFileController.abort()
            loadTldrFile(
              app,
              graphData,
              simulation,
              centerPoint,
              loadFile,
              currentVersion,
              setStudyPreferenceFromProject,
              projectID
            )
            refreshSim(simulation)
            dataInterval(netData, graphData, simulation)
            drawInterval()
            //app.setSetting("keepStyleMenuOpen",true)
            loadedFile.current = true
          }
        } else if (loadedFile.current === true) {
          //default update loop
          if (app.isLoading && app.document.name !== 'null') {
            clearInterval(networkIntervalRef.current)
            networkIntervalRef.current = null
            networkIntervalRef.current = setInterval(networkInterval, timeout * 2)
            app.setIsLoading(false)
          }

          //console.log('saving/updating?')
          if (!(app.document === undefined) && simulation.current) {
            //console.log('saving/updating...')
            updateSocketVersions(thumbnailSocket)
            saveToProcessing(
              app.document,
              JSON.stringify(graphData.current),
              simulation.current.alpha(),
              centerPoint.current,
              app.document.name,
              app.settings.sendUsageData,
              projectID,
              false
            )
          }
          if (app.document.name === 'null') {
            app.document.name = app.appState.currentProject
          }

          updateVersions(netData)
          dataInterval(netData, graphData, simulation)
        }
        // else{ //This shouldnt be reached
        //   console.log(loadFile.current)
        // }
      }
    }
  }
  //Update Current Version — (we want to do this very fast)
  const thumbnailInterval = () => {
    const app = rTldrawApp.current!
    if (!(app === undefined)) {
      const tlNodes = app
        .getShapes()
        .filter((shape: VersionNodeShape) => nodeRegex.test(shape.id) && shape.hasLoaded === false)
      tlNodes.map((node: { id: any }) => updateThumbnail(app, node.id, currentVersion))
    }
  }

  const handleSave = React.useCallback((app: TldrawApp, e?: KeyboardEvent) => {
    if (e !== undefined) {
      e.preventDefault()
    }
    if (simulation.current)
      saveToProcessing(
        app.document,
        JSON.stringify(graphData.current),
        simulation.current.alpha(),
        centerPoint.current,
        app.document.name,
        app.settings.sendUsageData,
        projectID,
        false
      )
  }, [])

  const resetState = React.useCallback((app: TldrawApp) => {
    abortFileController = new AbortController()
    currentVersion.current = null
    netData.current = undefined
    graphData.current = graphBaseData
    currentVersion.current = null
    loadFile.current = null
    loadedFile.current = false
    simulation.current = d3Sim()
    userID.current = ''
    projectID.current = ''
    if (app !== undefined) {
      app.setCurrentProject('')
      app.document.name = 'null'
      app.replacePageContent({}, {}, {})
      app.createShapes(defaultSticky(centerPoint.current))
      app.createShapes(...installHelper(centerPoint.current))
    }
  }, [])

  const handleMount = React.useCallback((app: TldrawApp) => {
    rTldrawApp.current = app
    centerPoint.current = app.centerPoint as [number, number]
    resetState(app)
    app.replacePageContent({}, {}, {})
    app.createShapes(defaultSticky(centerPoint.current))
    app.createShapes(...installHelper(centerPoint.current))
    app.selectNone()
    app.zoomToFit()
    app.setIsLoading(true)
  }, [])

  React.useEffect(() => {
    dataInterval(netData, graphData, simulation)
  }, [netData.current])

  React.useEffect(() => {
    // if(thumbnailSocket.current !== null){
    //   console.log(socketState.status)
    //   switch(thumbnailSocket.current.readyState){
    //     case W3CWebSocket.CLOSED:{
    //       if(rTldrawApp !== undefined){
    //         const app  : TldrawApp = rTldrawApp.current!
    //         if(app !== undefined){
    //           app.readOnly = true
    //           console.log(thumbnailSocket.current.readyState)
    //           app.setCurrentProject("")
    //           resetState(app)
    //         }
    //       }
    //       break
    //     }
    //     case W3CWebSocket.OPEN:{
    //       thumbnailSocket.current.send("/tldrfile")
    //       if(rTldrawApp !== undefined){
    //         const app  : TldrawApp = rTldrawApp.current!
    //         if(app !== undefined){
    //           app.readOnly = false
    //           console.log(thumbnailSocket.current.readyState)
    //           loadFileFromProcessing(loadFile,abortFileController)
    //           const tlNodes = app.getShapes().filter((shape) => nodeRegex.test(shape.id))
    //           tlNodes.map(node => updateThumbnail(app,node.id,currentVersion))
    //         }
    //       }
    //       break
    //     }
    //     case W3CWebSocket.CONNECTING:{
    //       break
    //     }
    //   }
    // }
  }, [socketState.status])

  React.useEffect(() => {}, [rTldrawApp.current?.settings.sendUsageData])

  React.useEffect(() => {
    //https://sparkjava.com/documentation#examples-and-faq
    //https://stackoverflow.com/questions/18206231/saving-and-reloading-a-force-layout-using-d3-js

    connectWebSocket(
      thumbnailSocket,
      currentVersion,
      rTldrawApp,
      connectInterval,
      loadFile,
      netData,
      userID,
      setStudyPreferenceFromSettings,
      abortFileController,
      resetState
    )
    networkIntervalRef.current = setInterval(networkInterval, 300) //get data from processing
    const thumbnailLoop = setInterval(thumbnailInterval, 10000) //update current version
    const drawLoop = setInterval(drawInterval, 100) //draw the graph

    return () => {
      clearInterval(networkIntervalRef?.current)
      clearInterval(thumbnailLoop)
      clearInterval(drawLoop)
      abortFileController.abort()
      resetState(rTldrawApp.current!)
    }
  }, [])

  //https://codesandbox.io/s/tldraw-context-menu-wen03q
  const handlePatch = React.useCallback((app: TldrawApp, patch: TldrawPatch, reason?: string) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(reason)
      // console.log('usagedata', app.settings.sendUsageData)
      // console.log('panel', showStudyConsent)
    }
    if (rTldrawApp.current?.settings.sendUsageData === 'Prompt') {
      setShowStudyConsent(true)
    }
    if (networkIntervalRef.current === null) {
      clearInterval(networkIntervalRef.current)
      networkIntervalRef.current = null
      networkIntervalRef.current = setInterval(networkInterval, timeout * 2)
    }

    if (loadedFile.current === true && app.document.name !== 'null' && simulation.current) {
      if (new Date().getTime() - timeSinceLastUsageLog.current > 10 * 60 * 1000) {
        if (app.settings.sendUsageData == 'Enabled') {
          sendUsageData(userID, projectID, '', '')
          timeSinceLastUsageLog.current = new Date().getTime()
        }
      }
      if (new Date().getTime() - timeSinceLastSave.current > 5 * 60 * 1000) {
        //every 5 min

        console.log('Backing up', new Date().getTime())
        saveToProcessing(
          app.document,
          JSON.stringify(graphData.current),
          simulation.current.alpha(),
          centerPoint.current,
          app.document.name,
          app.settings.sendUsageData,
          projectID,
          true
        )
        ;(window as any).gtag('event', 'backup')
        timeSinceLastSave.current = new Date().getTime()
      }
    }
    switch (reason) {
      case 'ui:set_current_project': {
        if (patch.appState.currentProject !== app.appState.currentProject) {
          if (patch.appState.currentProject === '') {
            app.readOnly = true
          } else {
            app.readOnly = false
            resetState(app)
            app.patchState(patch)
            app.appState.currentProject = patch.appState.currentProject
          }
        }
        break
      }
      case 'set_status:translating': {
        // started translating...
        rIsDragging.current = true
        lastSelection.current = null
        sendToLog('translate' + app.selectedIds)
        sendToUsageData('translate' + app.selectedIds)
        break
      }
      case 'set_status:creating': {
        // started translating...
        sendToLog(
          'creating' +
            app.pageState.editingId +
            '| Type:' +
            app.getShape(app.pageState.editingId).type.toString()
        )
        rIsDragging.current = true
        lastSelection.current = null
        break
      }
      case 'session:TranslateSession': {
        if (rIsDragging.current) {
          refreshSim(simulation)
          // Dragging...
        }
        lastSelection.current = null
        break
      }
      case 'set_status:idle': {
        if (rIsDragging.current) {
          // stopped translating...
          rIsDragging.current = false
        }
        refreshSim(simulation)
        break
      }
      //scaling
      case 'session:TransformSingleSession': {
        if (
          app.selectedIds.length == 1 &&
          app.getShape(app.selectedIds[0]).type === TDShapeType.VersionNode
        ) {
          //console.log(graphData.current.nodes)
        }
        lastSelection.current = null
        break
      }

      case 'set_status:pointingBounds': {
        //pointing bounds can never trigger selects unless node is in a group
        //lastSelection.current = selectedNodeId.current
        const hovered = app.getShape(app.pageState.hoveredId)
        if (
          app.selectedIds.length == 1 &&
          app.getShape(app.selectedIds[0]).type === TDShapeType.VersionNode
        ) {
          const timeSinceLastSelect = new Date().getTime() - timeSinceLastSelection.current
          if (
            app.shiftKey &&
            timeSinceLastSelect > 200
            //&& lastSelection.current === selectedNodeId.current
          ) {
            if (
              hovered !== undefined &&
              hovered.type == TDShapeType.VersionNode &&
              currentVersion.current
            ) {
              const idIntegerHovered = hovered.id.replace(/\D/g, '')
              if (idIntegerHovered === currentVersion.current.toString()) {
                const then = new Date().getTime()
                setTimeout(() => {
                  //if we dont get a selected event in the next half second
                  if (then > timeSinceLastSelection.current && currentVersion.current) {
                    sendFork(currentVersion.current.toString())
                    timeSinceLastSelection.current = new Date().getTime()
                  }
                }, 200)
              }
            }
          } else {
            if (hovered !== undefined && hovered.type == TDShapeType.VersionNode) {
              const idInteger = hovered.id.replace(/\D/g, '')
              //console.log("select",idInteger)
              sendSelect(idInteger)
              timeSinceLastSelection.current = new Date().getTime()
            }
          }
        } else {
          //console.log(app.pageState.hoveredId)

          if (hovered !== undefined) {
            if (hovered.type === TDShapeType.VersionNode) {
              const timeSinceLastSelect = new Date().getTime() - timeSinceLastSelection.current
              //console.log( hovered.id)
              if (
                app.shiftKey &&
                timeSinceLastSelect > 100
                //&& hovered.id === selectedNodeId.current
              ) {
                const then = new Date().getTime()
                setTimeout(() => {
                  //if we dont get a selected event in the next half second
                  if (then > timeSinceLastSelection.current && currentVersion.current) {
                    sendFork(currentVersion.current.toString())
                    timeSinceLastSelection.current = new Date().getTime()
                  }
                }, 100)
              } else {
                const idInteger = hovered.id.replace(/\D/g, '')
                //console.log("select",idInteger)
                sendSelect(idInteger)
                timeSinceLastSelection.current = new Date().getTime()
              }
            }
          }
        }
        break
      }
      case 'selected': {
        //select events are never the second click, so they can never trigger forks
        //Select Node
        const hovered = app.getShape(app.pageState.hoveredId)
        //lastSelection.current = selectedNodeId.current
        if (
          app.selectedIds.length == 1 &&
          app.getShape(app.selectedIds[0]).type === TDShapeType.VersionNode
        ) {
          //selectedNodeId.current = app.selectedIds[0]
          const selectedShape = app.getShape(app.selectedIds[0])
          const idInteger = selectedShape.id.replace(/\D/g, '')
          //console.log(hovered)
          let hoveredCheck = false
          if (
            hovered !== undefined &&
            hovered.type == TDShapeType.VersionNode &&
            currentVersion.current
          ) {
            const idIntegerHovered = hovered.id.replace(/\D/g, '')
            if (idIntegerHovered === currentVersion.current.toString()) {
              hoveredCheck = true
            }
          } else {
            hoveredCheck = true
          }
          if (
            app.shiftKey &&
            new Date().getTime() - timeSinceLastFork.current > 2000 &&
            hoveredCheck
          ) {
            sendFork(idInteger)
            timeSinceLastFork.current = new Date().getTime()
            timeSinceLastSelection.current = new Date().getTime()
          } else {
            sendSelect(idInteger)
            timeSinceLastSelection.current = new Date().getTime()
          }
        } else {
          //(app.pageState.hoveredId)

          if (hovered !== undefined) {
            if (hovered.type === TDShapeType.VersionNode) {
              //selectedNodeId.current = hovered.id
              //const selectedShape = app.getShape(selectedNodeId.current)
              const idInteger = hovered.id.replace(/\D/g, '')
              if (app.shiftKey && new Date().getTime() - timeSinceLastFork.current > 2000) {
                sendFork(idInteger)
                timeSinceLastFork.current = new Date().getTime()
                timeSinceLastSelection.current = new Date().getTime()
              } else {
                sendSelect(idInteger)
                timeSinceLastSelection.current = new Date().getTime()
              }
            }
          }
        }
        break
      }
    }
  }, [])

  // Send events to gtag as actions.
  // const handlePersist = React.useCallback((_app: TldrawApp, reason?: string) => {
  //   gtag.event({
  //     action: reason ?? '',
  //     category: 'editor',
  //     label: reason ?? 'persist',
  //     value: 0,
  //   })
  // }, [])

  const handleExport = React.useCallback(async (app: TldrawApp, info: TDExport): Promise<void> => {
    if (info.type === 'exportByColor') {
      exportByColor(app, info.name as ColorStyle)
    } else {
      // app.exportImage(TDExportType.PNG, { scale: 2, quality: 1 })
      const url = URL.createObjectURL(info.blob)
      const link = document.createElement('a')
      link.href = url

      link.download = `${info.name}.${info.type}`
      link.click()

      // const url = URL.createObjectURL(info.blob)
      // const link = document.createElement('a')
      // link.href = url
      // link.download = `${name}.${info.type}`
      // link.click()
    }
  }, [])

  const { onAssetUpload, onAssetDelete } = useUploadAssets()

  return (
    <div className="tldraw">
      {showStudyConsent && (
        <StudyConsentPopup container={undefined} setActive={setStudyPreferenceFromInterface} />
      )}

      <Tldraw
        id={id}
        autofocus
        showPages={false}
        onMount={handleMount}
        onPatch={handlePatch}
        onSaveProject={handleSave}
        showMultiplayerMenu={false}
        onAssetUpload={onAssetUpload}
        onAssetCreate={onAssetUpload}
        onAssetDelete={onAssetDelete}
        onExport={handleExport}
        {...rest}
      />
    </div>
  )
}

export default Editor
