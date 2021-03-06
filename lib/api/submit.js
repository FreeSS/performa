// Performa API Layer - Data Submission
// Copyright (c) 2019 Joseph Huckaby
// Released under the MIT License

var async = require('async');
var Class = require("pixl-class");
var Tools = require("pixl-tools");
var PixlMail = require('pixl-mail');
var safeEval = require('notevil');

module.exports = Class.create({
	
	api_hello: function(args, callback) {
		// receive a hello packet from a server
		// { version, hostname, group, nonce }
		var self = this;
		var params = args.params;
		var group_defs = this.groups;
		
		this.logDebug(9, "Received hello from server", params);
		
		if (!this.requireParams(params, {
			hostname: /^\S+$/,
			nonce: /^\S+$/
		}, callback)) return;
		
		// normalize hostname for storage (and sanity)
		params.hostname = this.storage.normalizeKey( params.hostname ).replace(/\//g, '');
		if (params.group) {
			params.group = this.storage.normalizeKey( params.group );
		}
		
		// detect group from hostname if not specified
		// if multiple groups match, pick the one with the lowest sort_order
		if (!params.group) {
			var lowest_sort_order = 999999;
			for (var idx = 0, len = group_defs.length; idx < len; idx++) {
				var group_def = group_defs[idx];
				if (params.hostname.match(group_def.hostname_match) && (group_def.sort_order < lowest_sort_order)) {
					params.group = group_def.id;
					lowest_sort_order = group_def.sort_order;
				}
			}
		}
		if (!params.group) {
			var msg = "Hostname is not a member of any groups: " + params.hostname;
			this.logTransaction('warning', msg);
			return this.doError( 'submit', msg, callback );
		}
		
		// validate group
		var group_def = Tools.findObject( group_defs, { id: params.group });
		if (!group_def) {
			this.logTransaction('warning', "Unknown group: " + params.group + " (sent from: " + params.hostname + ")");
			return this.doError( 'submit', "Unknown group: " + params.group, callback );
		}
		
		// gather matching & enabled commands
		var server_commands = [];
		this.commands.forEach( function(command) {
			if (group_def.id.match(command.group_match) && command.enabled) {
				server_commands.push(command);
			}
		});
		
		// send response with auth token
		callback({ 
			code: 0,
			nonce: params.nonce,
			auth: Tools.digestHex(params.nonce + this.server.config.get('secret_key'), 'sha256'),
			commands: server_commands
		});
	},
	
	api_submit: function(args, callback) {
		// receive a data packet from a server
		// { version, hostname, group, data }
		var self = this;
		var params = args.params;
		var group_defs = this.groups;
		
		if (!this.requireParams(params, {
			// date: /^\d+(\.\d+)?$/,
			hostname: /^\S+$/
		}, callback)) return;
		
		if (!params.data) {
			return this.doError( 'submit', "Missing required data object", callback );
		}
		
		this.logDebug(9, "Received data submission from: " + params.hostname, 
			this.debugLevel(10) ? params : null
		);
		
		// augment with IP address, for record keeping
		params.ip = args.ip;
		
		// always use server time, in case of clock drift
		params.date = Tools.timeNow(true);
		
		// normalize hostname for storage (and sanity)
		params.hostname = this.storage.normalizeKey( params.hostname ).replace(/\//g, '');
		if (params.group) {
			params.group = this.storage.normalizeKey( params.group );
			params.custom_group = true;
		}
		
		// detect group from hostname if not specified
		// if multiple groups match, pick the one with the lowest sort_order
		if (!params.group) {
			var lowest_sort_order = 999999;
			for (var idx = 0, len = group_defs.length; idx < len; idx++) {
				var group_def = group_defs[idx];
				if (params.hostname.match(group_def.hostname_match) && (group_def.sort_order < lowest_sort_order)) {
					params.group = group_def.id;
					lowest_sort_order = group_def.sort_order;
				}
			}
		}
		if (!params.group) {
			var msg = "Hostname is not a member of any groups: " + params.hostname;
			this.logTransaction('warning', msg);
			return this.doError( 'submit', msg, callback );
		}
		
		// validate group
		var group_def = Tools.findObject( group_defs, { id: params.group });
		if (!group_def) {
			this.logTransaction('warning', "Unknown group: " + params.group + " (sent from: " + params.hostname + ")");
			return this.doError( 'submit', "Unknown group: " + params.group, callback );
		}
		
		// enqueue processing for throttling
		this.storage.enqueue({ 
			action: 'custom', 
			label: 'Performa Data Submission',
			handler: this.processDataSubmission.bind(this),
			params: params
		});
		
		// send immediate response to client
		callback({ code: 0 });
	},
	
	processDataSubmission: function(task, callback) {
		// process data submission
		// this is throttled to N simultaneous
		var self = this;
		var params = task.params;
		var monitor_defs = this.monitors;
		var alert_defs = this.alerts;
		var group_defs = this.groups;
		var group_def = Tools.findObject( group_defs, { id: params.group });
		
		// resolve monitor data values
		var data = {};
		var delta_defs = [];
		
		// store computed monitor values in params.data, so alerts can refer to them
		params.data.monitors = {};
		params.data.deltas = {};
		
		monitor_defs.forEach( function(mon_def) {
			if (mon_def.group_match && !params.group.match(mon_def.group_match)) return;
			// var value = Tools.getPath( params.data, mon_def.source );
			var exp = Tools.sub( mon_def.source, params.data, true );
			var value = 0;
			if (exp) {
				// see if source expression has any math operations in it
				if (mon_def.source.replace(/\[.+?\]/g, '').match(/(\+|\-|\*|\/|\%|\(|\))/)) {
					try { value = safeEval( exp, params ); }
					catch (err) {
						self.logError('submit', "Monitor expression failed to evaluate: " + err, {
							monitor: mon_def,
							hostname: params.hostname,
							expression: exp
						});
					}
				}
				else {
					// simple value, no math expression included in template
					value = exp;
				}
			}
			else {
				self.logError('submit', "Monitor expression failed to evaluate", {
					monitor: mon_def,
					hostname: params.hostname,
					expression: mon_def.source
				});
			}
			
			// support custom data_match regexp to extract value out of string
			if (mon_def.data_match) {
				var matches = (''+value).match( mon_def.data_match );
				if (matches && (matches.length >= 2)) {
					// data_match has a group capture, use first group
					value = matches[1];
				}
				else if (matches) {
					// just grab entire match (no group)
					value = matches[0];
				}
				else {
					self.logError('submit', "Custom data regular expression did not match", {
						monitor: mon_def,
						hostname: params.hostname,
						raw_value: value
					});
					value = 0;
				}
			} // data_match
			
			switch (mon_def.data_type) {
				case 'integer': 
				case 'bytes':
				case 'seconds':
				case 'milliseconds':
					value = parseInt(value) || 0; 
				break;
				
				case 'string': 
					value = '' + value; 
				break;
				
				default: 
					value = parseFloat(value) || 0; 
				break;
			} // data_type
			
			// manipulate value (currently unused)
			if (mon_def.multiply) value *= mon_def.multiply;
			else if (mon_def.divide) value /= mon_def.divide;
			
			data[ mon_def.id ] = params.data.monitors[ mon_def.id ] = value;
			
			if (mon_def.delta) {
				// data will temporarily have the absolute counter, 
				// just until delta_defs is processed below
				delta_defs.push( mon_def );
			}
		} ); // foreach monitor
		
		var host_data = null;
		var host_key = 'hosts/' + params.hostname + '/data';
		params.alerts = {};
		
		// check for alert snooze
		var alerts_snoozed = false;
		if (this.state.alert_snooze && (this.state.alert_snooze > Tools.timeNow())) alerts_snoozed = true;
		
		async.series(
			[
				function(callback) {
					// lock hostname-based record
					self.storage.lock( host_key, true, callback );
				},
				function(callback) {
					// load host data or create new
					self.storage.get( host_key, function(err, data) {
						if (!data) {
							// brand new server
							data = { data: { monitors: {} }, alerts: {} };
							self.logTransaction('server_add', "New server added: " + params.hostname, {
								group: group_def,
								hostname: params.hostname,
								ip: params.ip
							});
						}
						else {
							// check if ip changed (log a warning)
							if (data.ip && (data.ip != params.ip)) {
								self.logTransaction('warning', "IP address has changed for: " + params.hostname + " (" + data.ip + " to " + params.ip + ")", {
									hostname: params.hostname,
									old_ip: data.ip,
									new_ip: params.ip
								});
							}
						}
						host_data = data;
						callback();
					});
				},
				function(callback) {
					// adjust any monitors that use deltas
					delta_defs.forEach( function(mon_def) {
						// so the idea here is that `host_data.data.monitors` always contains the absolute counter
						// only the sparse `data` object (for the timeline) will have the delta
						// this way we can compute the delta each time, using the host_data and incoming data
						if (!(mon_def.id in host_data.data.monitors)) {
							// first time for server, set delta to 0
							// host_data will be saved for next time
							data[ mon_def.id ] = 0;
							return;
						}
						
						var old_value = host_data.data.monitors[ mon_def.id ] || 0;
						var delta = data[ mon_def.id ] - old_value;
						
						if (mon_def.divide_by_delta && host_data.date) {
							var elapsed = (params.date - host_data.date) || 1;
							delta /= elapsed;
						}
						if (delta < 0) delta = 0;
						if (mon_def.data_type.match(/^(integer|bytes|seconds|milliseconds)$/)) {
							delta = Math.floor(delta);
						}
						
						data[ mon_def.id ] = delta;
						params.data.deltas[ mon_def.id ] = delta;
						// Note: params.data.monitors is deliberately NOT overwritten here, 
						// as it needs the absolute value for next time around.
						// But if alerts need to trigger on the delta, they should use [deltas/MONITOR_ID]
					} );
					
					// check for alerts
					alert_defs.forEach( function(alert_def) {
						if (alert_def.group_match && !params.group.match(alert_def.group_match)) return;
						var exp = Tools.sub( alert_def.expression, params.data );
						
						self.logDebug(9, "Checking alert expression " + exp, {
							alert: alert_def,
							hostname: params.hostname,
							expression: exp
						});
						
						var result = null;
						try { result = safeEval( exp, params ); }
						catch (err) {
							self.logError('submit', "Alert expression failed to evaluate: " + err, {
								alert: alert_def,
								hostname: params.hostname,
								expression: exp
							});
						}
						
						if (result === true) {
							params.alerts[ alert_def.id ] = {
								date: params.date,
								exp: exp,
								message: self.alertSub( alert_def.message, params.data )
							};
							
							// preserve original date when alert first triggered
							if (host_data.alerts && host_data.alerts[ alert_def.id ]) {
								params.alerts[ alert_def.id ].date = host_data.alerts[ alert_def.id ].date;
							}
						} // alert!
					} );
					
					// check for alert state changes
					for (var key in params.alerts) {
						if (!host_data.alerts[key]) {
							// new alert!
							var alert_def = Tools.findObject( alert_defs, { id: key } );
							
							self.logTransaction('alert_new', "New alert for: " + params.hostname + ": " + alert_def.title, { 
								def: alert_def, 
								alert: params.alerts[key],
								hostname: params.hostname 
							});
							
							if (group_def.alerts_enabled && alert_def.enabled && !alerts_snoozed) {
								// notifications are enabled for alert and group
								self.sendAlertNotification({
									template: "alert_new",
									def: alert_def,
									params: params,
									alert: params.alerts[key]
								});
							} // notifications enabled
							
							// store new alerts in params so timeline can use it
							if (!params.new_alerts) params.new_alerts = {};
							params.new_alerts[key] = true;
							
						} // new alert
					} // foreach alert
					
					for (var key in host_data.alerts) {
						if (!params.alerts[key]) {
							// alert cleared!
							var alert_def = Tools.findObject( alert_defs, { id: key } );
							if (alert_def) {
								self.logTransaction('alert_cleared', "Alert cleared: " + params.hostname + ": " + alert_def.title, { 
									def: alert_def, 
									alert: host_data.alerts[key],
									hostname: params.hostname 
								});
								
								if (group_def.alerts_enabled && alert_def.enabled && !alerts_snoozed) {
									self.sendAlertNotification({
										template: "alert_cleared",
										def: alert_def,
										params: params,
										alert: host_data.alerts[key],
										elapsed: Tools.timeNow(true) - host_data.alerts[key].date
									});
								} // alert enabled
							}
						} // alert cleared
					} // foreach alert
					
					// accumulate group data (will be flushed on the minute)
					self.updateGroupData( group_def.id, data );
					
					// accumulate alert data (will be flushed on the minute)
					self.alertCache[params.hostname] = params.alerts;
					
					process.nextTick(callback);
				},
				function(callback) {
					// add / merge into all timelines
					async.eachSeries( self.systems,
						function(sys, callback) {
							self.processSystem({
								sys: sys,
								params: params,
								data: data
							}, callback);
						},
						callback
					);
				},
				function(callback) {
					// write host data back to storage
					host_data = params;
					self.storage.put( host_key, host_data, callback );
				}
			],
			function(err) {
				// always unlock
				self.storage.unlock( host_key );
				if (err) {
					self.logError('submit', "Failed to submit data: " + (err.message || err), params);
				}
				else {
					self.logDebug(6, "Data submission complete for: " + params.hostname);
				}
				callback();
			}
		); // async.series
	},
	
	updateGroupData: function(group_id, data) {
		// merge in data values at the group level with totals
		// (this is flushed to disk every minute)
		if (!this.groupCache[group_id]) this.groupCache[group_id] = { totals: {}, count: 0 };
		var cache = this.groupCache[group_id];
		
		for (var key in data) {
			if (key in cache.totals) {
				if ((typeof(data[key]) == 'number') && (typeof(cache.totals[key]) == 'number')) {
					cache.totals[key] += data[key];
				}
				else cache.totals[key] = data[key];
			}
			else cache.totals[key] = data[key];
		}
		
		cache.count++;
	},
	
	processSystem: function(args, callback) {
		// process data submission into a single system (daily, monthly or yearly)
		var self = this;
		var sys = args.sys;
		var params = args.params;
		var data = args.data;
		
		var epoch = params.date;
		var epoch_div = Math.floor( epoch / sys.epoch_div );
		var timeline_key = 'timeline/' + sys.id + '/' + params.hostname + '/' + Tools.formatDate( epoch, sys.date_format );
		var update_data = null;
		
		// setup hostname cache per system
		if (!this.hostnameCache[sys.id]) this.hostnameCache[sys.id] = {};
		
		async.series(
			[
				function(callback) {
					// first, load last list item to see if epoch_div matches
					self.storage.listGet( timeline_key, -1, 1, function(err, items, list) {
						// construct cache key for hostname -- could include group if custom
						var host_cache_key = params.hostname;
						if (params.custom_group) host_cache_key = params.group + '/' + params.hostname;
						
						// make sure host's contribution is accounted for
						self.hostnameCache[ sys.id ][ host_cache_key ] = 1;
						
						if (items && items.length && (items[0].epoch_div == epoch_div)) {
							// final record matches epoch, we will merge
							update_data = items[0];
							
							// if system is marked as `single_only` call this an error
							// i.e. this is for when we have two servers with the same hostname submitting data at the same time
							if (sys.single_only) {
								return callback( new Error("Double submission in same minute for hostname: " + params.hostname) );
							}
						}
						else if (items && items.length && (items[0].epoch_div > epoch_div)) {
							// sanity check: this should NEVER happen
							return callback( new Error("Timeline out of order: Cannot submit " + epoch_div + " after " + items[0].epoch_div + " into " + timeline_key) );
						}
						callback();
					});
				},
				function(callback) {
					// push or merge
					if (update_data) {
						// merge data into record (same divided timestamp)
						for (var key in data) {
							if (key in update_data.totals) {
								if ((typeof(data[key]) == 'number') && (typeof(update_data.totals[key]) == 'number')) {
									update_data.totals[key] += data[key];
								}
								else update_data.totals[key] = data[key];
							}
							else update_data.totals[key] = data[key];
						}
						update_data.count++;
						
						// merge in new alerts
						if (params.new_alerts) {
							if (!update_data.alerts) update_data.alerts = {};
							Tools.mergeHashInto( update_data.alerts, params.new_alerts );
						}
						
						self.storage.listSplice( timeline_key, -1, 1, [update_data], callback );
					}
					else {
						// push new
						var item = {
							date: epoch_div * sys.epoch_div,
							epoch_div: epoch_div,
							totals: data,
							count: 1
						};
						
						// include alerts if any new ones just fired
						if (params.new_alerts) {
							item.alerts = params.new_alerts;
						}
						
						self.storage.listPush( timeline_key, item, function(err, list) {
							if (err) return callback(err);
							
							if ((list.length == 1) && self.server.config.get('expiration')) {
								// we just created the list, so set its expiration date
								var exp_date = Tools.timeNow() + Tools.getSecondsFromText( self.server.config.get('expiration') );
								self.storage.expire( timeline_key, exp_date );
							}
							
							callback();
						} ); // listPush
					} // push new
				}
			],
			callback
		); // async.series
	},
	
	sendAlertNotification: function(args) {
		// send email and/or web hooks for alert (new or clear)
		// args: { template, def, params, alert }
		var self = this;
		
		// add config to args
		args.config = this.server.config.get();
		
		// add nice date/time
		args.date_time = (new Date()).toString();
		
		// upper-case title for emphasis in plain text
		args.title_caps = args.def.title.toUpperCase();
		
		// nice group title
		var group_defs = this.groups;
		var group_def = Tools.findObject( group_defs, { id: args.params.group } );
		args.nice_group = group_def.title;
		
		// nice elapsed time, if present
		if (args.elapsed) {
			args.elapsed_nice = Tools.getTextFromSeconds( args.elapsed, false, true );
		}
		
		// nice server info
		args.nice_load_avg = Tools.shortFloat( args.params.data.load[0] );
		args.nice_mem_total = Tools.getTextFromBytes( args.params.data.memory.total );
		args.nice_mem_avail = Tools.getTextFromBytes( args.params.data.memory.available );
		args.nice_uptime = Tools.getTextFromSeconds( args.params.data.uptime_sec, false, true );
		// args.nice_os = Tools.ucfirst( args.params.data.platform ) + " " + args.params.data.release + " (" + args.params.data.arch + ")";
		args.nice_os = args.params.data.os.distro + " " + args.params.data.os.release; //  + " (" + args.params.data.os.arch + ")";
		args.nice_notes = args.def.notes || '(None)';
		args.nice_hostname = args.params.hostname;
		if (args.config.hostname_display_strip) {
			args.nice_hostname = args.nice_hostname.replace( args.config.hostname_display_strip, '' );
		}
		
		// construct URL to realtime view of server
		args.self_url = this.server.config.get('base_app_url') + '/#Server?hostname=' + args.params.hostname;
		
		// alert or group may override e-mail address
		args.email_to = args.def.email || group_def.alert_email || this.server.config.get('email_to');
		if (args.email_to) {
			// args.template: alert_new, alert_cleared
			// args.def.title
			// args.def.email
			// args.def.web_hook
			// args.params.hostname
			// args.alert.exp
			// args.alert.message
			
			// construct mailer
			var mail = new PixlMail( this.server.config.get('smtp_hostname'), this.server.config.get('smtp_port') || 25 );
			mail.setOptions( this.server.config.get('mail_options') || {} );
			
			// send it
			mail.send( 'conf/emails/' + args.template + '.txt', args, function(err, raw_email) {
				if (err) {
					var err_msg = "Failed to send alert e-mail: " + to + ": " + err;
					self.logError( 'mail', err_msg, { text: raw_email } );
					self.logTransaction('warning', err_msg);
				}
				else {
					self.logDebug(5, "Email sent successfully", { text: raw_email } );
				}
			} ); // mail.send
		} // email_to
		
		// construct web hook args
		var hook_args = {
			action: args.template, // alert_new or alert_cleared
			definition: args.def,
			alert: args.alert,
			hostname: args.params.hostname,
			group: args.params.group,
			url: args.self_url
		};
		if (args.template == 'alert_new') {
			hook_args.text = args.config.client.name + " Alert: " + args.nice_hostname + ": " + args.def.title + ": " + args.alert.message + " - ([View Details](" + args.self_url + "))";
		}
		else if (args.template == 'alert_cleared') {
			hook_args.text = args.config.client.name + " Alert Cleared: " + args.nice_hostname + ": " + args.def.title;
		}
		
		// alert-specific web hook
		var alert_web_hook_url = args.def.web_hook || group_def.alert_web_hook || '';
		if (alert_web_hook_url) {
			this.logDebug(9, "Firing web hook for alert: " + args.def.id + ": " + alert_web_hook_url);
			this.request.json( alert_web_hook_url, hook_args, function(err, resp, data) {
				// log response
				if (err) self.logDebug(9, "Alert Web Hook Error: " + alert_web_hook_url + ": " + err);
				else self.logDebug(9, "Alert Web Hook Response: " + alert_web_hook_url + ": HTTP " + resp.statusCode + " " + resp.statusMessage);
			} );
		}
		
		// global web hook for all alerts
		var uni_web_hook_url = this.server.config.get('alert_web_hook') || '';
		if (uni_web_hook_url) {
			this.logDebug(9, "Firing universal web hook for alert: " + args.def.id + ": " + uni_web_hook_url);
			this.request.json( uni_web_hook_url, hook_args, function(err, resp, data) {
				// log response
				if (err) self.logDebug(9, "Universal Web Hook Error: " + uni_web_hook_url + ": " + err);
				else self.logDebug(9, "Universal Web Hook Response: " + uni_web_hook_url + ": HTTP " + resp.statusCode + " " + resp.statusMessage);
			} );
		}
	},
	
	alertSub: function(text, data) {
		// a special alert-specific wrapper around Tools.sub()
		// which allows special [bytes:PATH] and will convert the PATH value
		// to a human-readable bytes representation, e.g. "4.5 GB"
		var handlers = {
			bytes: function(value) { return Tools.getTextFromBytes( parseInt(value) ); },
			commify: function(value) { return Tools.commify( parseInt(value) ); },
			pct: function(value) { return Tools.pct( value, 100 ); },
			integer: function(value) { return parseInt(value); },
			float: function(value) { return Tools.shortFloat(value); }
		};
		text = text.replace(/\[(\w+)\:([^\]]+)\]/g, function(m_all, m_g1, m_g2) {
			return (m_g1 in handlers) ? handlers[m_g1]( Tools.getPath(data, m_g2) ) : m_all;
		});
		return Tools.sub(text, data);
	}
	
} );
