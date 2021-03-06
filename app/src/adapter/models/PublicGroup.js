define(function(require, exports, module)
{
	'use strict';

	var lib = require('glympse-adapter/lib/utils');
	var raf = require('glympse-adapter/lib/rafUtils');
	var ajax = require('glympse-adapter/lib/ajax');

	var Defines = require('glympse-adapter/GlympseAdapterDefines');

	var m = Defines.MSG;

	var cDemoGroups;

	// Exported class
	function PublicGroup(controller, account, groupName, cfg)
	{
		///////////////////////////////////////////////////////////////////////////////
		// PROPERTIES
		///////////////////////////////////////////////////////////////////////////////

		//constants
		var dbg = lib.dbg('PublicGroup', cfg.dbg);
		var svr = cfg.svcGlympse;

		var idGroup = encodeURIComponent(groupName);

		var urlEvents = ('groups/' + idGroup + '/events');
		var urlInitial = ('groups/' + idGroup);
		var urlInitialParams = { branding: true };

		//state
		var loaded = false;
		var next = 0;
		var lastUpdate = 0;
		var demoGroup = cDemoGroups[groupName.toString().toLowerCase()];
		var users = [];

		var that = this;


		///////////////////////////////////////////////////////////////////////////////
		// PROPERTIES
		///////////////////////////////////////////////////////////////////////////////

		this.getInvites = function()
		{
			for (var i = users.length - 1, invites = []; i >= 0; i--)
			{
				invites.push(users[i].invite);
			}

			return invites;
		};

		this.getName = function()
		{
			return idGroup;
		};

		this.getUsers = function()
		{
			return users;
		};


		///////////////////////////////////////////////////////////////////////////////
		// PUBLIC
		///////////////////////////////////////////////////////////////////////////////

		this.request = function()
		{
			return requestGroup();
		};

		this.setData = function(data)
		{
			if (data)
			{
				return processGroupInitial({ status: true, response: data, time: Date.now() });
			}
		};

		this.toString = function()
		{
			return 'PublicGroup: ' + JSON.stringify({ name: idGroup, numUsers: users.length, numInvites: this.getInvites().length });
		};

		this.toJSON = function()
		{
			return { name: idGroup, users: users, invites: this.getInvites() };
		};


		///////////////////////////////////////////////////////////////////////////////
		// UTILITY
		///////////////////////////////////////////////////////////////////////////////

		function requestGroup()
		{
			if (!loaded)
			{
				//console.log('::: :: INITIAL REQUEST :: ::: -- ' + idGroup);
				if (demoGroup)
				{
					raf.setTimeout(function()
					{
						processGroupInitial(demoGroup);
					}, 200);

					return true;	// do not poll demo groups
				}

				ajax.get(svr + urlInitial, urlInitialParams, account)
					.then(processGroupInitial);

				return false;
			}

			if (demoGroup)
			{
				return true;	// do not poll demo groups
			}

			//console.log('::: :: EVENTS REQUEST :: :::');
			ajax.get(svr + urlEvents, { next: next }, account)
				.then(processGroupUpdate);

			return false;
		}

		function sendStatus(result, invitesAdded, invitesRemoved, invitesSwapped)
		{
			result.group = groupName;

			// Only send an update if some invite status is found
			if (!(invitesAdded.length > 0 || invitesRemoved.length > 0 || invitesSwapped.length > 0))
			{
				return;
			}

			result.invitesAdded = invitesAdded;
			result.invitesRemoved = invitesRemoved;
			result.invitesSwapped = invitesSwapped;

			controller.notify(m.GroupStatus, result);
		}

		// Parse returned initial Glympse Public Group results
		function processGroupInitial(result)
		{
			loaded = true; // We're initialized, even if there is an error

			var invitesAdded = [];
			var invitesRemoved = [];
			var invitesSwapped = [];

			if (result.status)
			{
				parseGroupListResponse(result, invitesAdded, invitesRemoved, invitesSwapped);
			}

			sendStatus(result, invitesAdded, invitesRemoved, invitesSwapped);
			controller.notify(m.GroupLoaded, result);
		}

		// Parse returned subsequent Glympse Public Group event results
		function processGroupUpdate(result)
		{
			var invitesAdded = [];
			var invitesRemoved = [];
			var invitesSwapped = [];

			loaded = true; // We're done, even if there is an error

			//console.log('processGroupUpdate: got data: ' + data + ' -- ' + data.result);
			if (result.status)
			{
				var o = result.response;

				if (o.type === 'group')
				{
					parseGroupListResponse(result, invitesAdded, invitesRemoved, invitesSwapped);
				}
				else //if (o.type === 'events')
				{
					next = (o.events) ? (o.events + 1) : 0;
					lastUpdate = result.time;
					//console.log('EVENTS next = ' + next);

					// Handle new invites from new/pre-existing clients, and people leaving the group
					var items = o.items;
					if (items)
					{
						var i, len, item;

						// cleanup events list first (take only latest event for particular member)
						var events = [];
						var members = [];
						// order matters!
						for (i = 0, len = items.length; i < len; i++)
						{
							item = items[i];
							switch (item.type)
							{
								case 'invite':
								case 'swap':
								case 'leave':
								{
									var mem = item.member;
									var memIndex = members.indexOf(mem);

									if (memIndex !== -1)
									{
										dbg('>> Cleanup outdated event: ', events[memIndex]);
										members.splice(memIndex, 1);
										events.splice(memIndex, 1);
									}

									members.push(mem);
									events.push(item);

									break;
								}
							}
						}

						// proceed with clean list of events
						var user, swap;
						for (i = 0, len = events.length; i < len; i++)
						{
							item = events[i];
							//console.log('UPDATE type=' + item.type);
							switch (item.type)
							{
								case 'invite':
								case 'swap':
								{
									var inv = item.invite;

									// See if we already have the user of the new 'invite'
									user = findUser(item.member);

									//console.log('[INVITE]member=' + item.member + '(found=' + (user != null) + ') oldInvite=' + (user && user.invite) + ', newInvite=' + inv);
									if (user)
									{
										if (user.invite === inv)
										{
											dbg('>> Skip existing invite: ', inv);
										}
										else
										{
											// If so, queue to remove the old invite and replace with the new one
											swap = { user: user.id, invOld: user.invite, invNew: inv };
											dbg('>> Invite swap: ', swap);
											invitesSwapped.push(swap);
											user.invite = inv;
										}
									}
									else
									{
										// Otherwise, they are a new user to track
										dbg('>> ADD: ', inv);
										invitesAdded.push(inv);
										users.push({ id: item.member, invite: inv });
									}

									break;
								}

								case 'leave':
								{
									//console.log('[LEAVE]member=' + item.member + ' -- found=' + (user != null));
									// If user is leaving, remove their invite and user list entry
									user = findUser(item.member);
									if (user)
									{
										dbg('>> REMOVE: ', user.invite);
										invitesRemoved.push(user.invite);
										users.splice(users.indexOf(user), 1);
									}

									break;
								}
							}
						}
					}
				}
			}

			sendStatus(result, invitesAdded, invitesRemoved, invitesSwapped);
		}

		function parseGroupListResponse(result, invitesAdded, invitesRemoved, invitesSwapped)
		{
			var i;
			var o = result.response;

			next = o.events + 1;
			lastUpdate = result.time;

			// Handle inline viewing configuration
			if (o.branding)
			{
				//TODO: pass brand cfg to the viewer
			}

			var members = o.members;
			if (members)
			{
				var len = members.length;
				var u, mem;
				//console.log('members:' + JSON.stringify(members, null, '    '));
				// Sync up existing user list with their current invites
				for (i = users.length - 1; i >= 0; i--)
				{
					u = users[i];
					for (var j = len - 1; j >= 0; j--)
					{
						mem = members[j];

						if (u.id === mem.id)
						{
							// Check if we have a new invite code for an existing user
							if (u.invite !== mem.invite)
							{
								var swap = { user: u.id, invOld: u.invite, invNew: mem.invite };
								dbg('** Invite swap: ', swap);
								u.invite = mem.invite;
								invitesSwapped.push(swap);
							}

							// User still exists in the current list, so don't remove
							u = null;
							break;
						}
					}

					// If not in the new list, remove the user
					if (u)
					{
						dbg('** REMOVE: ', u.invite);
						invitesRemoved.push(u.invite);
						users.splice(i, 1);
					}
				}

				// Locate and add any new users
				for (i = len - 1; i >= 0; i--)
				{
					mem = members[i];

					// Don't add a new user if they already exist in the current user list
					if (findUser(mem.id))
					{
						continue;
					}

					if (mem.invite)
					{
						//console.log('id=' + cli.id + ', invite=' + cli.invite);
						users.push(mem);
						dbg('** ADD: ', mem.invite);
						invitesAdded.push(mem.invite);
					}
				}
			}
		}

		function findUser(id)
		{
			for (var j = users.length - 1, userLocated = null; j >= 0; j--)
			{
				var user = users[j];
				if (user.id === id)
				{
					userLocated = user;
					break;
				}
			}

			return userLocated;
		}


		// Fill demoshuttle drivers
		if (cfg.demoDriversCount)
		{
			// Allowed range is [0-7]
			var driversCount = Math.max(0, Math.min(cfg.demoDriversCount, 7));
			var demoshuttleMembers = cDemoGroups.demoshuttle.response.members;
			for (var i = driversCount - 1; i >= 0; i--)
			{
				demoshuttleMembers.push({ id: 'DNA7-4HDZ-03WH' + i, invite: 'demobot' + i })
			}
		}
	}

	cDemoGroups = {
		bryanaroundseattle: {
			status: true,
			response: {
				type: 'group',
				id: 119,
				events: 1,
				members: [{ id: 'DNA7-4HDZ-03WHE', invite: 'demobot0' }],
				public: true,
				name: 'BryanTheRussel'
			},
			time: Date.now()
		},
		seattleteam: {
			status: true,
			response: {
				type: 'group',
				id: 119,
				events: 1,
				members: [
					{ id: 'DNA7-4HDZ-03WH0', invite: 'demobot0' },
					{ id: 'DNA7-4HDZ-03WH1', invite: 'demobot1' },
					{ id: 'DNA7-4HDZ-03WH2', invite: 'demobot2' },
					{ id: 'DNA7-4HDZ-03WH3', invite: 'demobot3' },
					{ id: 'DNA7-4HDZ-03WH4', invite: 'demobot4' },
					{ id: 'DNA7-4HDZ-03WH5', invite: 'demobot5' },
					{ id: 'DNA7-4HDZ-03WH6', invite: 'demobot6' },
					{ id: 'DNA7-4HDZ-03WH7', invite: 'demobot7' }
				],
				public: true,
				name: 'SeattleTeam'
			},
			time: Date.now()
		},
		demoshuttle: {
			status: true,
			response: {
				type: 'group',
				id: 119,
				events: 1,
				members: [],
				public: true,
				name: 'DemoShuttle',
				branding: {
					org_id: -999
				}
			},
			time: Date.now()
		}
	};

	module.exports = PublicGroup;
});
