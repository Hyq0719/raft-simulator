/* jshint globalstrict: true */
/* jshint browser: true */
/* jshint devel: true */
/* jshint jquery: true */
/* global util */
/* global raft */
/* global makeState */
/* global ELECTION_TIMEOUT */
/* global NUM_SERVERS */
'use strict';

var playback;
var render = {};
var state;
var record;
var replay;

var userConfig = {
  nodeFailureRate: 10,                // 每分钟故障率
  leaderRequestRate: 30,              // leader每分钟收到的请求数量
  faultDuration:{min: 10000, max: 20000} // 故障持续时间的最小和最大值
};

function startSimulationFromConfig(config) {
  // Update userConfig with the new configuration passed from HTML
  raft.updateRpcLatency(config.rpcMinLatency*1000,config.rpcMaxLatency*1000)
  userConfig.nodeFailureRate = config.nodeFailureRate;
  userConfig.leaderRequestRate = config.leaderRequestRate;
  userConfig.faultDuration ={ min: config.minFaultDuration, max: config.maxFaultDuration};
  userConfig.rpcLatency = {min: config.rpcMinLatency*1000, max: config.rpcMaxLatency*1000};

  // Assume you have some initialization or reset function to start the simulation
  initializeTimers();
  console.log('Simulation started with new config:', userConfig);
  playback.toggle();
}

// Make sure to expose this function to be accessible from the outside
window.startSimulationFromConfig = startSimulationFromConfig;

var isActive = false; // 全局控制所有定时器的活动状态
var getLeader = function () {
  var leader = null;
  var term = 0;
  state.current.servers.forEach(function (server) {
    if (server.state == 'leader' &&
        server.term > term) {
      leader = server;
      term = server.term;
    }
  });
  return leader;
};
var timers = {
  nodeFailures: {
    id: null,
    start: function() {
      if (this.id === null) { // 确保定时器未在运行
        this.id = setInterval(() => {
          if (Math.random() < userConfig.nodeFailureRate / 60) {
            var failedServer = Math.floor(Math.random() * NUM_SERVERS);
            console.log("Node failure simulated for server", failedServer);
            if (state && state.current && state.current.servers && raft.stop) {
              raft.stop(state.current, state.current.servers[failedServer]);
              var faultDuration = userConfig.faultDuration.min + Math.random() * (userConfig.faultDuration.max - userConfig.faultDuration.min);
              setTimeout(() => {
                console.log("Node recovery simulated for server", failedServer);
                if (raft.restart) {
                  raft.restart(state.current, state.current.servers[failedServer]);
                }
              }, faultDuration);
            }
          }
        }, 1000);
      }
    },
    stop: function() {
      if (this.id !== null) {
        clearInterval(this.id);
        this.id = null;
      }
    }
  },
  leaderRequests: {
    id: null,
    start: function () {
      if (this.id === null) {
        // 根据每分钟的请求次数计算请求间隔
        const requestInterval = 60000 / userConfig.leaderRequestRate;

        this.id = setInterval(() => {
          // 尝试找到当前的 leader
          const leader = getLeader(); // 假设有一个函数 getLeader() 返回当前的 leader 或 null
          if (leader !== null) {
            console.log("Sending request to leader", leader.id);
            // 这里调用发送请求的函数
            raft.clientRequest(state.current, leader);
          } else {
            console.log("Leader not found, request failed.");
            // 可以设置一个短暂的延迟后再次检查 leader 是否存在
            setTimeout(() => {
              const leaderRetry = getLeader();
              if (leaderRetry !== null) {
                console.log("Sending request to leader after delay", leaderRetry.id);
                raft.clientRequest(state.current, leaderRetry);
              } else {
                console.log("Leader still not found, request definitely failed.");
              }
            }, requestInterval / 2); // 例如在间隔的一半时间后再次尝试
          }
        }, requestInterval);
      }
    },
    stop: function () {
      if (this.id !== null) {
        clearInterval(this.id);
        this.id = null;
      }
    }
  }
};

function timerAllResume() {
  if (isActive) {
    // 停止所有定时器
    Object.keys(timers).forEach(timerKey => {
      timers[timerKey].stop();
    });
    isActive = false;
    console.log("All timers paused.");
  } else {
    // 启动所有定时器
    Object.keys(timers).forEach(timerKey => {
      timers[timerKey].start();
    });
    isActive = true;
    console.log("All timers resumed.");
  }
}

// 初始化所有定时器的函数
function initializeTimers() {
  //TODO
  Object.keys(timers).forEach(timerKey => {
    timers[timerKey].start();
  });
  isActive = true; // 标记为激活状态
}

$(function () {

  var ARC_WIDTH = 5;

  var onReplayDone = undefined;
  record = function (name) {
    localStorage.setItem(name, state.exportToString());
  };
  replay = function (name, done) {
    state.importFromString(localStorage.getItem(name));
    render.update();
    onReplayDone = done;
  };

  state = makeState({
    servers: [],
    messages: [],
  });

  var sliding = false;

  var termColors = [
    '#89CFF0', // Baby Blue
    '#FFB6C1', // Light Pink
    '#C1E1C1', // Light Green
    '#FFD700', // Gold
    '#FF9E9D', // Light Coral
    '#B19CD9', // Light Purple
  ];


  var SVG = function (tag) {
    return $(document.createElementNS('http://www.w3.org/2000/svg', tag));
  };

  playback = function () {
    var paused = false;
    var pause = function () {
      paused = true;
      $('#time-icon')
          .removeClass('glyphicon-time')
          .addClass('glyphicon-pause');
      $('#pause').attr('class', 'paused');
      render.update();
    };
    var resume = function () {
      if (paused) {
        paused = false;
        $('#time-icon')
            .removeClass('glyphicon-pause')
            .addClass('glyphicon-time');
        $('#pause').attr('class', 'resumed');
        render.update();
      }
    };
    return {
      pause: pause,
      resume: resume,
      toggle: function () {
        if (paused)
          resume();
        else
          pause();
      },
      isPaused: function () {
        return paused;
      },
    };
  }();

  (function () {
    for (var i = 1; i <= NUM_SERVERS; i += 1) {
      var peers = [];
      for (var j = 1; j <= NUM_SERVERS; j += 1) {
        if (i != j)
          peers.push(j);
      }
      state.current.servers.push(raft.server(i, peers));
    }
  })();

  var svg = $('svg');

  var ringSpec = {
    cx: 210,
    cy: 210,
    r: 150,
  };
  $('#pause').attr('transform',
      'translate(' + ringSpec.cx + ', ' + ringSpec.cy + ') ' +
      'scale(' + ringSpec.r / 3.5 + ')');

  var logsSpec = {
    x: 430,
    y: 50,
    width: 320,
    height: 270,
  };


  var serverSpec = function (id) {
    var coord = util.circleCoord((id - 1) / NUM_SERVERS,
        ringSpec.cx, ringSpec.cy, ringSpec.r);
    return {
      cx: coord.x,
      cy: coord.y,
      r: 30,
    };
  };

  $('#ring', svg).attr(ringSpec);

  var serverModal;
  var messageModal;

  state.current.servers.forEach(function (server) {
    var s = serverSpec(server.id);
    $('#servers', svg).append(
        SVG('g')
            .attr('id', 'server-' + server.id)
            .attr('class', 'server')
            .append(SVG('text')
                .attr('class', 'serverid')
                .text('S' + server.id)
                .attr(util.circleCoord((server.id - 1) / NUM_SERVERS,
                    ringSpec.cx, ringSpec.cy, ringSpec.r + 50)))
            .append(SVG('a')
                .append(SVG('circle')
                    .attr('class', 'background')
                    .attr(s))
                .append(SVG('g')
                    .attr('class', 'votes'))
                .append(SVG('path')
                    .attr('style', 'stroke-width: ' + ARC_WIDTH))
                .append(SVG('text')
                    .attr('class', 'term')
                    .attr({x: s.cx, y: s.cy}))
            ));
  });

  var MESSAGE_RADIUS = 8;

  var messageSpec = function (from, to, frac) {
    var fromSpec = serverSpec(from);
    var toSpec = serverSpec(to);
    // adjust frac so you start and end at the edge of servers
    var totalDist = Math.sqrt(Math.pow(toSpec.cx - fromSpec.cx, 2) +
        Math.pow(toSpec.cy - fromSpec.cy, 2));
    var travel = totalDist - fromSpec.r - toSpec.r;
    frac = (fromSpec.r / totalDist) + frac * (travel / totalDist);
    return {
      cx: fromSpec.cx + (toSpec.cx - fromSpec.cx) * frac,
      cy: fromSpec.cy + (toSpec.cy - fromSpec.cy) * frac,
      r: MESSAGE_RADIUS,
    };
  };

  var messageArrowSpec = function (from, to, frac) {
    var fromSpec = serverSpec(from);
    var toSpec = serverSpec(to);
    // adjust frac so you start and end at the edge of servers
    var totalDist = Math.sqrt(Math.pow(toSpec.cx - fromSpec.cx, 2) +
        Math.pow(toSpec.cy - fromSpec.cy, 2));
    var travel = totalDist - fromSpec.r - toSpec.r;
    var fracS = ((fromSpec.r + MESSAGE_RADIUS) / totalDist) +
        frac * (travel / totalDist);
    var fracH = ((fromSpec.r + 2 * MESSAGE_RADIUS) / totalDist) +
        frac * (travel / totalDist);
    return [
      'M', fromSpec.cx + (toSpec.cx - fromSpec.cx) * fracS, comma,
      fromSpec.cy + (toSpec.cy - fromSpec.cy) * fracS,
      'L', fromSpec.cx + (toSpec.cx - fromSpec.cx) * fracH, comma,
      fromSpec.cy + (toSpec.cy - fromSpec.cy) * fracH,
    ].join(' ');
  };

  var comma = ',';
  var arcSpec = function (spec, fraction) {
    var radius = spec.r + ARC_WIDTH / 2;
    var end = util.circleCoord(fraction, spec.cx, spec.cy, radius);
    var s = ['M', spec.cx, comma, spec.cy - radius];
    if (fraction > 0.5) {
      s.push('A', radius, comma, radius, '0 0,1', spec.cx, spec.cy + radius);
      s.push('M', spec.cx, comma, spec.cy + radius);
    }
    s.push('A', radius, comma, radius, '0 0,1', end.x, end.y);
    return s.join(' ');
  };

  var timeSlider;

  render.clock = function () {
    if (!sliding) {
      timeSlider.slider('setAttribute', 'max', state.getMaxTime());
      timeSlider.slider('setValue', state.current.time, false);
    }
  };

  var serverActions = [
    ['stop', raft.stop],
    ['resume', raft.resume],
    ['restart', raft.restart],
    ['time out', raft.timeout],
    ['request', raft.clientRequest],
  ];

  var messageActions = [
    ['drop', raft.drop],
  ];

  render.servers = function (serversSame) {
    state.current.servers.forEach(function (server) {
      var serverNode = $('#server-' + server.id, svg);
      $('path', serverNode)
          .attr('d', arcSpec(serverSpec(server.id),
              util.clamp((server.electionAlarm - state.current.time) /
                  (ELECTION_TIMEOUT * 2),
                  0, 1)));
      if (!serversSame) {
        $('text.term', serverNode).text(server.term);
        serverNode.attr('class', 'server ' + server.state);
        $('circle.background', serverNode)
            .attr('style', 'fill: ' +
                (server.state == 'stopped' ? 'gray'
                    : termColors[server.term % termColors.length]));
        var votesGroup = $('.votes', serverNode);
        votesGroup.empty();
        if (server.state == 'candidate') {
          state.current.servers.forEach(function (peer) {
            var coord = util.circleCoord((peer.id - 1) / NUM_SERVERS,
                serverSpec(server.id).cx,
                serverSpec(server.id).cy,
                serverSpec(server.id).r * 5 / 8);
            var state;
            if (peer == server || server.voteGranted[peer.id]) {
              state = 'have';
            } else if (peer.votedFor == server.id && peer.term == server.term) {
              state = 'coming';
            } else {
              state = 'no';
            }
            var granted = (peer == server ? true : server.voteGranted[peer.id]);
            votesGroup.append(
                SVG('circle')
                    .attr({
                      cx: coord.x,
                      cy: coord.y,
                      r: 5,
                    })
                    .attr('class', state));
          });
        }
        serverNode
            .unbind('click')
            .click(function () {
              serverModal(state.current, server);
              return false;
            });
        if (serverNode.data('context'))
          serverNode.data('context').destroy();
        serverNode.contextmenu({
          target: '#context-menu',
          before: function (e) {
            var closemenu = this.closemenu.bind(this);
            var list = $('ul', this.getMenu());
            list.empty();
            serverActions.forEach(function (action) {
              list.append($('<li></li>')
                  .append($('<a href="#"></a>')
                      .text(action[0])
                      .click(function () {
                        state.fork();
                        action[1](state.current, server);
                        state.save();
                        render.update();
                        closemenu();
                        return false;
                      })));
            });
            return true;
          },
        });
      }
    });
  };

  render.entry = function (spec, entry, committed) {
    return SVG('g')
        .attr('class', 'entry ' + (committed ? 'committed' : 'uncommitted'))
        .append(SVG('rect')
            .attr(spec)
            .attr('stroke-dasharray', committed ? '1 0' : '5 5')
            .attr('style', 'fill: ' + termColors[entry.term % termColors.length]))
        .append(SVG('text')
            .attr({
              x: spec.x + spec.width / 2,
              y: spec.y + spec.height / 2
            })
            .text(entry.term));
  };

  render.logs = function () {
    var LABEL_WIDTH = 25;
    var INDEX_HEIGHT = 25;
    var logsGroup = $('.logs', svg);
    logsGroup.empty();
    logsGroup.append(
        SVG('rect')
            .attr('id', 'logsbg')
            .attr(logsSpec));
    var height = (logsSpec.height - INDEX_HEIGHT) / NUM_SERVERS;
    var leader = getLeader();
    var indexSpec = {
      x: logsSpec.x + LABEL_WIDTH + logsSpec.width * 0.05,
      y: logsSpec.y + 2 * height / 6,
      width: logsSpec.width * 0.9,
      height: 2 * height / 3,
    };
    var indexes = SVG('g')
        .attr('id', 'log-indexes');
    logsGroup.append(indexes);
    for (var index = 1; index <= 15; ++index) {
      var indexEntrySpec = {
        x: indexSpec.x + (index - 0.5) * indexSpec.width / 11,
        y: indexSpec.y,
        width: indexSpec.width / 11,
        height: indexSpec.height,
      };
      indexes
          .append(SVG('text')
              .attr(indexEntrySpec)
              .text(index));
    }
    state.current.servers.forEach(function (server) {
      var logSpec = {
        x: logsSpec.x + LABEL_WIDTH + logsSpec.width * 0.05,
        y: logsSpec.y + INDEX_HEIGHT + height * server.id - 5 * height / 6,
        width: logsSpec.width * 0.9,
        height: 2 * height / 3,
      };
      var logEntrySpec = function (index) {
        return {
          x: logSpec.x + (index - 1) * logSpec.width / 11,
          y: logSpec.y,
          width: logSpec.width / 11,
          height: logSpec.height,
        };
      };
      var log = SVG('g')
          .attr('id', 'log-S' + server.id);
      logsGroup.append(log);
      log.append(
          SVG('text')
              .text('S' + server.id)
              .attr('class', 'serverid ' + server.state)
              .attr({
                x: logSpec.x - LABEL_WIDTH * 4 / 5,
                y: logSpec.y + logSpec.height / 2
              }));
      for (var index = 1; index <= 15; ++index) {
        log.append(SVG('rect')
            .attr(logEntrySpec(index))
            .attr('class', 'log'));
      }
      server.log.forEach(function (entry, i) {
        var index = i + 1;
        log.append(render.entry(
            logEntrySpec(index),
            entry,
            index <= server.commitIndex));
      });
      if (leader !== null && leader != server) {
        log.append(
            SVG('circle')
                .attr('title', 'match index')//.tooltip({container: 'body'})
                .attr({
                  cx: logEntrySpec(leader.matchIndex[server.id] + 1).x,
                  cy: logSpec.y + logSpec.height,
                  r: 5
                }));
        var x = logEntrySpec(leader.nextIndex[server.id] + 0.5).x;
        log.append(SVG('path')
            .attr('title', 'next index')//.tooltip({container: 'body'})
            .attr('style', 'marker-end:url(#TriangleOutM); stroke: black')
            .attr('d', ['M', x, comma, logSpec.y + logSpec.height + logSpec.height / 3,
              'L', x, comma, logSpec.y + logSpec.height + logSpec.height / 6].join(' '))
            .attr('stroke-width', 3));
      }
    });
    var iconsY = logsSpec.y + logsSpec.height + 50; // 调整Y坐标以放在日志框的下方
    // 添加"match index"圆点和文本
    logsGroup.append(SVG('circle')
        .attr({
          cx: logsSpec.x + 30,
          cy: iconsY,
          r: 5,
          fill: 'black'
        }));
    logsGroup.append(SVG('text')
        .text(' = Match Index')
        .attr({
          x: logsSpec.x + 85,
          y: iconsY,
          'font-size': '14px',
          'font-family': 'Arial'
        }));

    // 添加"next index"箭头和文本
    logsGroup.append(SVG('path')
        .attr({
          d: 'M ' + (logsSpec.x + 150) + ' ' + (iconsY + 10) + ' l 0 -10',
          stroke: 'black',
          'stroke-width': 3, // 加粗箭头
          'marker-end': 'url(#TriangleOutM)'
        }));
    logsGroup.append(SVG('text')
        .text(' = Next Index')
        .attr({
          x: logsSpec.x + 200,
          y: iconsY,
          'font-size': '14px',
          'font-family': 'Arial'
        }));
  };

  render.messages = function (messagesSame) {
    var messagesGroup = $('#messages', svg);
    if (!messagesSame) {
      messagesGroup.empty();
      state.current.messages.forEach(function (message, i) {
        var a = SVG('a')
            .attr('id', 'message-' + i)
            .attr('class', 'message ' + message.direction + ' ' + message.type)
            .attr('title', message.type + ' ' + message.direction)//.tooltip({container: 'body'})
            .append(SVG('circle'))
            .append(SVG('path').attr('class', 'message-direction'));
        if (message.direction == 'reply')
          a.append(SVG('path').attr('class', 'message-success'));
        messagesGroup.append(a);
      });
      state.current.messages.forEach(function (message, i) {
        var messageNode = $('a#message-' + i, svg);
        messageNode
            .click(function () {
              messageModal(state.current, message);
              return false;
            });
        if (messageNode.data('context'))
          messageNode.data('context').destroy();
        messageNode.contextmenu({
          target: '#context-menu',
          before: function (e) {
            var closemenu = this.closemenu.bind(this);
            var list = $('ul', this.getMenu());
            list.empty();
            messageActions.forEach(function (action) {
              list.append($('<li></li>')
                  .append($('<a href="#"></a>')
                      .text(action[0])
                      .click(function () {
                        state.fork();
                        action[1](state.current, message);
                        state.save();
                        render.update();
                        closemenu();
                        return true;
                      })));
            });
            return true;
          },
        });
      });
    }
    state.current.messages.forEach(function (message, i) {
      var s = messageSpec(message.from, message.to,
          (state.current.time - message.sendTime) /
          (message.recvTime - message.sendTime));
      $('#message-' + i + ' circle', messagesGroup)
          .attr(s);
      if (message.direction == 'reply') {
        var dlist = [];
        dlist.push('M', s.cx - s.r, comma, s.cy,
            'L', s.cx + s.r, comma, s.cy);
        if ((message.type == 'RequestVote' && message.granted) ||
            (message.type == 'AppendEntries' && message.success)) {
          dlist.push('M', s.cx, comma, s.cy - s.r,
              'L', s.cx, comma, s.cy + s.r);
        }
        $('#message-' + i + ' path.message-success', messagesGroup)
            .attr('d', dlist.join(' '));
      }
      var dir = $('#message-' + i + ' path.message-direction', messagesGroup);
      if (playback.isPaused()) {
        dir.attr('style', 'marker-end:url(#TriangleOutS-' + message.type + ')')
            .attr('d',
                messageArrowSpec(message.from, message.to,
                    (state.current.time - message.sendTime) /
                    (message.recvTime - message.sendTime)));
      } else {
        dir.attr('style', '').attr('d', 'M 0,0'); // clear
      }
    });
  };

  var relTime = function (time, now) {
    if (time == util.Inf)
      return 'infinity';
    var sign = time > now ? '+' : '';
    return sign + ((time - now) / 1e3).toFixed(3) + 'ms';
  };

  var button = function (label) {
    return $('<button type="button" class="btn btn-default"></button>')
        .text(label);
  };

  serverModal = function (model, server) {
    var m = $('#modal-details');
    $('.modal-title', m).text('Server ' + server.id);
    $('.modal-dialog', m).removeClass('modal-sm').addClass('modal-lg');
    var li = function (label, value) {
      return '<dt>' + label + '</dt><dd>' + value + '</dd>';
    };
    var peerTable = $('<table></table>')
        .addClass('table table-condensed')
        .append($('<tr></tr>')
            .append('<th>peer</th>')
            .append('<th>next index</th>')
            .append('<th>match index</th>')
            .append('<th>vote granted</th>')
            .append('<th>RPC due</th>')
            .append('<th>heartbeat due</th>')
        );
    server.peers.forEach(function (peer) {
      peerTable.append($('<tr></tr>')
          .append('<td>S' + peer + '</td>')
          .append('<td>' + server.nextIndex[peer] + '</td>')
          .append('<td>' + server.matchIndex[peer] + '</td>')
          .append('<td>' + server.voteGranted[peer] + '</td>')
          .append('<td>' + relTime(server.rpcDue[peer], model.time) + '</td>')
          .append('<td>' + relTime(server.heartbeatDue[peer], model.time) + '</td>')
      );
    });
    $('.modal-body', m)
        .empty()
        .append($('<dl class="dl-horizontal"></dl>')
            .append(li('state', server.state))
            .append(li('currentTerm', server.term))
            .append(li('votedFor', server.votedFor))
            .append(li('commitIndex', server.commitIndex))
            .append(li('electionAlarm', relTime(server.electionAlarm, model.time)))
            .append($('<dt>peers</dt>'))
            .append($('<dd></dd>').append(peerTable))
        );
    var footer = $('.modal-footer', m);
    footer.empty();
    serverActions.forEach(function (action) {
      footer.append(button(action[0])
          .click(function () {
            state.fork();
            action[1](model, server);
            state.save();
            render.update();
            m.modal('hide');
          }));
    });
    m.modal();
  };

  messageModal = function (model, message) {
    var m = $('#modal-details');
    $('.modal-dialog', m).removeClass('modal-lg').addClass('modal-sm');
    $('.modal-title', m).text(message.type + ' ' + message.direction);
    var li = function (label, value) {
      return '<dt>' + label + '</dt><dd>' + value + '</dd>';
    };
    var fields = $('<dl class="dl-horizontal"></dl>')
        .append(li('from', 'S' + message.from))
        .append(li('to', 'S' + message.to))
        .append(li('sent', relTime(message.sendTime, model.time)))
        .append(li('deliver', relTime(message.recvTime, model.time)))
        .append(li('term', message.term));
    if (message.type == 'RequestVote') {
      if (message.direction == 'request') {
        fields.append(li('lastLogIndex', message.lastLogIndex));
        fields.append(li('lastLogTerm', message.lastLogTerm));
      } else {
        fields.append(li('granted', message.granted));
      }
    } else if (message.type == 'AppendEntries') {
      if (message.direction == 'request') {
        var entries = '[' + message.entries.map(function (e) {
          return e.term;
        }).join(' ') + ']';
        fields.append(li('prevIndex', message.prevIndex));
        fields.append(li('prevTerm', message.prevTerm));
        fields.append(li('entries', entries));
        fields.append(li('commitIndex', message.commitIndex));
      } else {
        fields.append(li('success', message.success));
        fields.append(li('matchIndex', message.matchIndex));
      }
    }
    $('.modal-body', m)
        .empty()
        .append(fields);
    var footer = $('.modal-footer', m);
    footer.empty();
    messageActions.forEach(function (action) {
      footer.append(button(action[0])
          .click(function () {
            state.fork();
            action[1](model, message);
            state.save();
            render.update();
            m.modal('hide');
          }));
    });
    m.modal();
  };

// Transforms the simulation speed from a linear slider
// to a logarithmically scaling time factor.
  var speedSliderTransform = function (v) {
    v = Math.pow(10, v);
    if (v < 1)
      return 1;
    else
      return v;
  };

  var lastRenderedO = null;
  var lastRenderedV = null;
  render.update = function () {
    // Same indicates both underlying object identity hasn't changed and its
    // value hasn't changed.
    var serversSame = false;
    var messagesSame = false;
    if (lastRenderedO == state.current) {
      serversSame = util.equals(lastRenderedV.servers, state.current.servers);
      messagesSame = util.equals(lastRenderedV.messages, state.current.messages);
    }
    lastRenderedO = state;
    lastRenderedV = state.base();
    render.clock();
    render.servers(serversSame);
    render.messages(messagesSame);
    if (!serversSame)
      render.logs();
  };

  (function () {
    var last = null;
    var step = function (timestamp) {
      if (!playback.isPaused() && last !== null && timestamp - last < 500) {
        var wallMicrosElapsed = (timestamp - last) * 1000;
        var speed = speedSliderTransform($('#speed').slider('getValue'));
        var modelMicrosElapsed = wallMicrosElapsed / speed;
        var modelMicros = state.current.time + modelMicrosElapsed;
        state.seek(modelMicros);
        if (modelMicros >= state.getMaxTime() && onReplayDone !== undefined) {
          var f = onReplayDone;
          onReplayDone = undefined;
          f();
        }
        render.update();
      }
      last = timestamp;
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  })();

  $(window).keyup(function (e) {
    if (e.target.id == "title")
      return;
    var leader = getLeader();
    if (e.keyCode == ' '.charCodeAt(0) ||
        e.keyCode == 190 /* dot, emitted by Logitech remote */) {
      $('.modal').modal('hide');
      playback.toggle();
      timerAllResume();
    } else if (e.keyCode == 'C'.charCodeAt(0)) {
      if (leader !== null) {
        state.fork();
        raft.clientRequest(state.current, leader);
        state.save();
        render.update();
        $('.modal').modal('hide');
      }
    } else if (e.keyCode == 'R'.charCodeAt(0)) {
      if (leader !== null) {
        state.fork();
        raft.stop(state.current, leader);
        raft.resume(state.current, leader);
        state.save();
        render.update();
        $('.modal').modal('hide');
      }
    } else if (e.keyCode == 'T'.charCodeAt(0)) {
      state.fork();
      raft.spreadTimers(state.current);
      state.save();
      render.update();
      $('.modal').modal('hide');
    } else if (e.keyCode == 'A'.charCodeAt(0)) {
      state.fork();
      raft.alignTimers(state.current);
      state.save();
      render.update();
      $('.modal').modal('hide');
    } else if (e.keyCode == 'L'.charCodeAt(0)) {
      state.fork();
      playback.pause();
      raft.setupLogReplicationScenario(state.current);
      state.save();
      render.update();
      $('.modal').modal('hide');
    } else if (e.keyCode == 'B'.charCodeAt(0)) {
      state.fork();
      raft.resumeAll(state.current);
      state.save();
      render.update();
      $('.modal').modal('hide');
    } else if (e.keyCode == 'F'.charCodeAt(0)) {
      state.fork();
      render.update();
      $('.modal').modal('hide');
    } else if (e.keyCode == 191 && e.shiftKey) { /* question mark */
      playback.pause();
      $('#modal-help').modal('show');
    }
  });

  $('#modal-details').on('show.bs.modal', function (e) {
    playback.pause();
  });

  var getLeader = function () {
    var leader = null;
    var term = 0;
    state.current.servers.forEach(function (server) {
      if (server.state == 'leader' &&
          server.term > term) {
        leader = server;
        term = server.term;
      }
    });
    return leader;
  };

  $("#speed").slider({
    tooltip: 'always',
    formater: function (value) {
      return '1/' + speedSliderTransform(value).toFixed(0) + 'x';
    },
    reversed: true,
  });

  timeSlider = $('#time');
  timeSlider.slider({
    tooltip: 'always',
    formater: function (value) {
      return (value / 1e5).toFixed(2) + 's';
    },
  });
  timeSlider.on('slideStart', function () {
    playback.pause();
    sliding = true;
  });
  timeSlider.on('slideStop', function () {
    // If you click rather than drag,  there won't be any slide events, so you
    // have to seek and update here too.
    state.seek(timeSlider.slider('getValue'));
    sliding = false;
    render.update();
  });
  timeSlider.on('slide', function () {
    state.seek(timeSlider.slider('getValue'));
    render.update();
  });

  $('#time-button')
      .click(function () {
        playback.toggle();
        timerAllResume();
        return false;
      });

// Disabled for now, they don't seem to behave reliably.
// // enable tooltips
// $('[data-toggle="tooltip"]').tooltip();

  state.updater = function (state) {
    raft.update(state.current);
    var time = state.current.time;
    var base = state.base(time);
    state.current.time = base.time;
    var same = util.equals(state.current, base);
    state.current.time = time;
    return !same;
  };

  state.init();
  render.update();
  playback.toggle();
});

