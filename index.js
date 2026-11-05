// 2. Handle voice channel verification workflow
client.on('voiceStateUpdate', async (oldState, newState) => {
  console.log(`[VoiceUpdate] User ${newState.member?.user.tag} moved from channel ${oldState.channelId} to ${newState.channelId}`);

  // Check if the user just joined the specific verification voice channel
  if (newState.channelId === TARGET_VC_ID && oldState.channelId !== TARGET_VC_ID) {
    const member = newState.member;

    // Check if the user has the "not verified" role
    if (!member.roles.cache.has(NOT_VERIFIED_ROLE_ID)) {
      console.log(`[VoiceUpdate] User ${member.user.tag} joined target VC, but does NOT have the unverified role.`);
      return;
    }

    try {
      const guild = newState.guild;

      // Create a new voice channel named after the user
      const newChannel = await guild.channels.create({
        name: `verify-${member.user.username}`,
        type: ChannelType.GuildVoice,
        parent: CATEGORY_ID || null,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionsBitField.Flags.ViewChannel],
          },
          {
            id: member.id,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
          },
          {
            id: STAFF_ROLE_ID,
            allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
          },
        ],
      });

      // Move the user into the newly created voice channel
      await member.voice.setChannel(newChannel);
      console.log(`Created verification channel ${newChannel.name} and moved ${member.user.tag}`);

      // Notify staff in a text channel
      const textChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && (c.name.includes('staff') || c.name.includes('general') || c.name.includes('verification')));
      if (textChannel) {
        textChannel.send(`<@&${STAFF_ROLE_ID}> New verification session started for **${member.user.tag}** in voice channel **${newChannel.name}**.`);
      }

    } catch (error) {
      console.error(`Failed to create verification voice channel: ${error.message}`);
    }
  }
});