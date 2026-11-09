(function (root) {
  'use strict'
  const Engine = root.MiniGolfEngine
  const Save = root.MiniGolfSave
  const Render = root.MiniGolfRender
  const COURSES = root.MiniGolfCourses
  const SAVE_KEY = 'save'
  const SINK_HOLD = 1.5
  const ICONS = {
    flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>'
  }
  const app = document.getElementById('app')
  const state = { save: Save.newSave(), palette: null, game: null, view: 'library' }
  let frame = null
  let last = null

  function icon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>'
  }
  function formatPar(difference) {
    if (difference === 0) return 'Even'
    return difference > 0 ? '+' + difference : String(difference)
  }
  function formatDate(at) {
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  function footer(left) {
    return left ? '<div class="foot"><span class="score">' + left + '</span></div>' : ''
  }
  function persist() {
    orca.host.call('storage.set', { key: SAVE_KEY, value: state.save }).catch((error) => console.error('Putt Request could not save', error))
  }
  function paletteFor(course) {
    return Object.assign({}, state.palette, course.turf)
  }
  function paintThumbnails() {
    app.querySelectorAll('canvas[data-hole]').forEach((canvas) => {
      const course = COURSES[Number(canvas.dataset.course)]
      Render.paintThumbnail(canvas, course.holes[Number(canvas.dataset.hole)], paletteFor(course))
    })
  }
  function leave() {
    if (frame !== null) root.cancelAnimationFrame(frame)
    frame = null
    last = null
    state.game = null
  }
  function thumb(courseIndex, hole) {
    return '<canvas data-course="' + courseIndex + '" data-hole="' + hole + '"></canvas>'
  }
  function card(action, courseIndex, hole, title, subtitle, extra) {
    return '<button class="card" data-action="' + action + '" data-course="' + courseIndex + '"' + (extra || '') + '>' + thumb(courseIndex, hole) + '<b>' + title + '</b><small>' + subtitle + '</small></button>'
  }
  function lockedCard(courseIndex) {
    return '<div class="card locked" aria-disabled="true">' + thumb(courseIndex, 0) + '<span class="badge">' + icon('lock') + '</span><b>' + COURSES[courseIndex].name + '</b><small>Finish ' + COURSES[courseIndex - 1].name + '</small></div>'
  }

  function showLibrary() {
    leave()
    state.view = 'library'
    const save = state.save
    let cards = ''
    if (Save.endlessReady(save, COURSES)) {
      const pool = Save.endlessPool(save, COURSES).length
      const total = Save.totalHoles(COURSES)
      cards += card('endless', 0, 1, 'Endless', (pool < total ? pool + ' of ' + total : total) + ' holes · Best ' + Save.bestStreak(save))
    }
    const lastIndex = COURSES.findIndex((course) => course.id === save.last)
    const current = lastIndex === -1 ? null : Save.peek(save, COURSES[lastIndex]).current
    if (current !== null) {
      cards += card('play', lastIndex, current, 'Continue', COURSES[lastIndex].name + ' · Hole ' + (current + 1), ' data-hole-index="' + current + '"')
    }
    COURSES.forEach((course, index) => {
      if (!Save.courseOpen(save, COURSES, index)) {
        cards += lockedCard(index)
        return
      }
      const best = Save.bestCourse(save, course)
      cards += card('course', index, 0, course.name, course.holes.length + ' holes · ' + (best ? 'Best ' + best : 'Unplayed'))
    })
    app.innerHTML = '<div class="top">' + icon('flag') + '<span class="where">Putt Request</span><button class="iconbutton push" data-action="board" aria-label="Leaderboard" title="Leaderboard">' + icon('trophy') + '</button></div><div class="body"><div class="grid">' + cards + '</div></div>' + footer()
    paintThumbnails()
  }

  function showCourse(courseIndex) {
    leave()
    state.view = 'course'
    const course = COURSES[courseIndex]
    const progress = Save.peek(state.save, course)
    const cells = course.holes.map((_, index) => {
      if (index >= progress.unlocked) {
        return '<div class="cell locked" aria-label="Hole ' + (index + 1) + ' locked"><span class="lock">' + icon('lock') + '</span><small>' + (index + 1) + '</small></div>'
      }
      const strokes = progress.round[index]
      return '<button class="cell' + (index === progress.current ? ' current' : '') + '" data-action="play" data-course="' + courseIndex + '" data-hole-index="' + index + '" title="' + course.holes[index].name + '">' + thumb(courseIndex, index) + '<small>' + (index + 1) + (strokes ? ' · ' + strokes : '') + '</small></button>'
    }).join('')
    const resume = progress.current !== null ? progress.current : 0
    const label = progress.current !== null && progress.round.length ? 'Continue from hole ' + (resume + 1) : 'Start course'
    const best = Save.bestCourse(state.save, course)
    app.innerHTML = '<div class="top"><button class="iconbutton" data-action="library" aria-label="Back">' + icon('left') + '</button><span class="where">' + course.name + '</span></div><div class="body"><small>' + course.holes.length + ' holes · Par ' + course.par + (best ? ' · Best ' + best : '') + '</small><div class="holes">' + cells + '</div><button class="primary" data-action="play" data-course="' + courseIndex + '" data-hole-index="' + resume + '">' + label + '</button></div>' + footer()
    paintThumbnails()
  }

  function stat(label, value, detail) {
    return '<div class="stat"><small>' + label + '</small><strong>' + value + '</strong><small>' + detail + '</small></div>'
  }
  function showBoard() {
    leave()
    state.view = 'board'
    const save = state.save
    const all = Save.bestOfAll(save, COURSES)
    const overall = all ? stat('Best of all courses', all.total, formatPar(all.toPar) + ' · ' + all.parts.join(' + ')) : stat('Best of all courses', '–', 'Finish all ' + COURSES.length + ' courses to post one.')
    let endless = ''
    if (Save.endlessReady(save, COURSES)) {
      const streak = save.endlessBoard[0]
      endless = '<div class="stats">' + (streak ? stat('Endless best', streak.streak, 'in a row · ' + formatDate(streak.at)) : stat('Endless best', '–', 'No streak yet')) + '</div>'
    }
    app.innerHTML = '<div class="top"><button class="iconbutton" data-action="library" aria-label="Back">' + icon('left') + '</button><span class="where">Your leaderboard</span></div><div class="body"><div class="stats one">' + overall + '</div>' + endless + '</div>' + footer()
  }

  function showFinished(courseIndex, result) {
    leave()
    state.view = 'finished'
    const course = COURSES[courseIndex]
    const next = COURSES[courseIndex + 1]
    const best = Save.bestCourse(state.save, course)
    const rankLine = result.rank === 1 ? 'New best' : result.rank ? 'Number ' + result.rank + ' on your board' : 'Best ' + best
    const again = '<button class="' + (result.firstFinish && next ? 'secondary' : 'primary') + '" data-action="play" data-course="' + courseIndex + '" data-hole-index="0">Play again</button>'
    const unlocked = result.firstFinish && next ? '<span class="unlock">' + icon('unlock') + next.name + ' unlocked</span><button class="primary" data-action="play" data-course="' + (courseIndex + 1) + '" data-hole-index="0">Play ' + next.name + '</button>' : ''
    app.innerHTML = '<div class="top"><button class="iconbutton" data-action="library" aria-label="Back">' + icon('left') + '</button><span class="where">' + course.name + '</span></div><div class="body finished"><strong>' + result.total + '</strong><small>' + formatPar(result.toPar) + ' · ' + rankLine + '</small>' + unlocked + again + '<button class="secondary" data-action="board">Leaderboard</button></div>' + footer()
  }

  function startGame(hole, course, where, scoreHtml, events) {
    leave()
    app.innerHTML = '<div class="top"><button class="iconbutton" data-action="' + events.back + '"' + (events.backCourse !== undefined ? ' data-course="' + events.backCourse + '"' : '') + ' aria-label="Back">' + icon('left') + '</button><span class="where">' + where + '</span><span class="strokes push">' + strokesText(hole, 0) + '</span></div><div class="stage"><canvas class="field" aria-label="Golf hole. Drag back and release to putt."></canvas></div>' + footer(scoreHtml)
    const canvas = app.querySelector('canvas.field')
    const game = { canvas, context: canvas.getContext('2d'), source: hole, course, palette: null, hole: null, aspect: null, ball: null, aim: null, strokes: 0, sinkTime: null, message: '', scored: false, events, leftover: 0, background: null }
    state.game = game
    sizeField()
    canvas.addEventListener('pointerdown', (event) => {
      if (game.ball.moving || game.ball.sunk) return
      canvas.setPointerCapture(event.pointerId)
      const point = toCourse(game, event)
      game.aim = { start: point, current: point }
      requestFrame()
    })
    canvas.addEventListener('pointermove', (event) => {
      if (game.aim) {
        game.aim.current = toCourse(game, event)
        requestFrame()
      }
    })
    canvas.addEventListener('pointerup', () => {
      if (!game.aim) return
      const shot = Engine.shotFromDrag(game.aim.start, game.aim.current)
      game.aim = null
      if (shot && shot.power > Engine.MIN_POWER) {
        Engine.strike(game.ball, shot, game.hole)
        game.strokes += 1
        app.querySelector('.strokes').textContent = strokesText(game.hole, game.strokes)
      }
      requestFrame()
    })
    canvas.addEventListener('pointercancel', () => {
      game.aim = null
      requestFrame()
    })
  }
  function strokesText(hole, strokes) {
    return 'Par ' + hole.par + ' · ' + strokes
  }
  function toCourse(game, event) {
    const box = game.canvas.getBoundingClientRect()
    return { x: ((event.clientX - box.left) / box.width) * Engine.WIDTH, y: ((event.clientY - box.top) / box.height) * game.hole.height }
  }
  function sizeField() {
    const game = state.game
    if (!game) return
    const stage = app.querySelector('.stage')
    const ratio = Engine.clampAspect(stage.clientHeight / Math.max(1, stage.clientWidth))
    if (ratio !== game.aspect) {
      const fitted = Engine.fitHole(game.source, ratio)
      if (game.ball) Engine.moveBall(game.ball, game.hole, fitted)
      else game.ball = Engine.createBall(fitted)
      game.hole = fitted
      game.aspect = ratio
    }
    game.palette = paletteFor(game.course)
    const width = Math.max(120, Math.min(stage.clientWidth, stage.clientHeight / ratio))
    const dpr = Math.max(1, root.devicePixelRatio || 1)
    game.canvas.style.width = Math.round(width) + 'px'
    game.canvas.style.height = Math.round(width * ratio) + 'px'
    game.canvas.width = Math.round(width * dpr)
    game.canvas.height = Math.round(width * ratio * dpr)
    game.background = document.createElement('canvas')
    game.background.width = game.canvas.width
    game.background.height = game.canvas.height
    Render.paintHole(game.background.getContext('2d'), game.hole, game.palette, Render.CELL)
    drawGame()
  }
  function drawGame() {
    const game = state.game
    if (!game || !game.background) return
    const shot = game.aim ? Engine.shotFromDrag(game.aim.start, game.aim.current) : null
    Render.drawFrame(game.context, game.background, { ball: game.ball, shot, sinkTime: game.sinkTime, hole: game.hole, message: game.message }, game.palette)
  }

  function playCourseHole(courseIndex, index) {
    state.view = 'play'
    const course = COURSES[courseIndex]
    Save.startHole(state.save, course, index)
    persist()
    const hole = course.holes[index]
    startGame(hole, course, (index + 1) + '. ' + hole.name, coursePar(course), {
      back: 'course',
      backCourse: courseIndex,
      sunk(game) {
        game.result = Save.finishCourseHole(state.save, course, index, game.strokes, Date.now())
        game.message = game.strokes === 1 ? 'HOLE IN ONE' : 'HOLED IN ' + game.strokes
        persist()
        if (!game.result.finished) app.querySelector('.score').innerHTML = coursePar(course)
      },
      done(game) {
        const current = Save.peek(state.save, course).current
        if (game.result.finished) showFinished(courseIndex, game.result)
        else if (current !== null) playCourseHole(courseIndex, current)
        else showCourse(courseIndex)
      }
    })
  }
  function coursePar(course) {
    return 'To par <b>' + formatPar(Save.toPar(state.save, course)) + '</b>'
  }
  function endlessScore() {
    return 'Streak <b>' + state.save.endless.streak + '</b><span class="best"> · Best <b>' + Save.bestStreak(state.save) + '</b></span>'
  }
  function playEndless() {
    state.view = 'play'
    const slot = Save.nextEndlessHole(state.save, COURSES, Math.random)
    const { course, hole } = Save.holeAt(COURSES, slot)
    startGame(hole, course, hole.name, endlessScore(), {
      back: 'library',
      sunk(game) {
        const result = Save.finishEndlessHole(state.save, COURSES, game.strokes, Date.now())
        game.message = !result.madePar ? 'STREAK LOST' : game.strokes === 1 ? 'HOLE IN ONE' : 'HOLED IN ' + game.strokes
        persist()
        app.querySelector('.score').innerHTML = endlessScore()
      },
      done() {
        playEndless()
      }
    })
  }

  app.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action
    if (action === 'library') showLibrary()
    else if (action === 'course') showCourse(Number(target.dataset.course))
    else if (action === 'board') showBoard()
    else if (action === 'endless') playEndless()
    else if (action === 'play') playCourseHole(Number(target.dataset.course), Number(target.dataset.holeIndex))
  })

  function requestFrame() {
    if (frame !== null) return
    if (last === null) last = performance.now()
    frame = root.requestAnimationFrame(loop)
  }
  function loop(now) {
    frame = null
    const game = state.game
    const elapsed = Math.min(0.05, (now - last) / 1000)
    last = now
    if (game) {
      if (game.ball.moving) game.leftover += elapsed
      while (game.ball.moving && game.leftover >= Engine.STEP) {
        Engine.stepBall(game.ball, game.hole)
        game.leftover -= Engine.STEP
      }
      if (!game.ball.moving) game.leftover = 0
      if (game.ball.sunk && game.sinkTime === null) game.sinkTime = 0
      if (game.sinkTime !== null) {
        if (!game.scored) {
          game.scored = true
          game.events.sunk(game)
        }
        game.sinkTime += elapsed
        if (game.sinkTime > SINK_HOLD) game.events.done(game)
      }
      if (state.game === game) drawGame()
    }
    if (state.game === game && game && (game.ball.moving || game.sinkTime !== null)) requestFrame()
    else last = null
  }

  function repaintForTheme() {
    state.palette = Render.readPalette()
    paintThumbnails()
    if (state.game) sizeField()
  }

  new ResizeObserver(() => {
    if (state.game) sizeField()
  }).observe(app)

  async function start() {
    state.palette = Render.readPalette()
    try {
      const { value } = await orca.host.call('storage.get', { key: SAVE_KEY })
      state.save = Save.loadSave(value)
    } catch (error) {
      console.error('Putt Request could not load its save', error)
    }
    showLibrary()
    orca.on('theme', () => setTimeout(repaintForTheme, 0))
  }
  void start()
})(globalThis)
