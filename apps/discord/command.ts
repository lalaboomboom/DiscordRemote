import { ChannelType, SlashCommandBuilder } from "discord.js";

export function buildTerminalCommands() {
  return [
    new SlashCommandBuilder().setName("sessions").setDescription("List discovered terminals and sharing status")
      .addStringOption(o => o.setName("machine").setDescription("Filter to one configured machine").setAutocomplete(true)),
    new SlashCommandBuilder().setName("status").setDescription("Show status for this channel's terminal"),
    new SlashCommandBuilder().setName("output").setDescription("Read recent output from this channel's terminal")
      .addIntegerOption(o => o.setName("lines").setDescription("Last lines, 1–100 (default 30)").setMinValue(1).setMaxValue(100)),
    new SlashCommandBuilder().setName("send").setDescription("Send one line to this channel's terminal")
      .addStringOption(o => o.setName("text").setDescription("Literal input; a real shell may execute it").setRequired(true).setMaxLength(500)),
    new SlashCommandBuilder().setName("key").setDescription("Send one named key to this channel's terminal")
      .addStringOption(o => o.setName("key").setDescription("Key to press").setRequired(true).addChoices(
        { name: "Enter", value: "enter" },
        { name: "Ctrl-C", value: "ctrl-c" },
        { name: "Escape", value: "escape" },
        { name: "Tab", value: "tab" },
        { name: "Up", value: "up" },
        { name: "Down", value: "down" },
        { name: "Left", value: "left" },
        { name: "Right", value: "right" },
        { name: "Shift + Left", value: "shift-left" },
      )),
    new SlashCommandBuilder().setName("interrupt").setDescription("Send Ctrl-C to this channel's terminal"),
    new SlashCommandBuilder().setName("run").setDescription("Run one bounded command on the selected machine")
      .addStringOption(o => o.setName("command").setDescription("Command to execute on the selected host").setRequired(true).setMaxLength(500))
      .addIntegerOption(o => o.setName("timeout").setDescription("Timeout in seconds (default 15)").setMinValue(1).setMaxValue(60)),
    new SlashCommandBuilder().setName("gpu").setDescription("Query GPU status on the selected machine"),
    new SlashCommandBuilder().setName("notify").setDescription("Notify this channel when its pinned Codex thread finishes a turn")
      .addSubcommand(sub => sub.setName("on").setDescription("Watch future native completions and send recent terminal output")
        .addStringOption(o => o.setName("thread").setDescription("Exact Codex Session UUID shown by Codex /status").setRequired(true).setMaxLength(36))
        .addIntegerOption(o => o.setName("lines").setDescription("Terminal lines to send, default 60").setMinValue(50).setMaxValue(70)))
      .addSubcommand(sub => sub.setName("off").setDescription("Disable completion notifications in this channel"))
      .addSubcommand(sub => sub.setName("status").setDescription("Show the pinned thread and notification state")),
    new SlashCommandBuilder().setName("setup").setDescription("Set the guild's operator channel")
      .addChannelOption(o => o.setName("orchestrator").setDescription("Text channel for machine management (default: this channel)").addChannelTypes(ChannelType.GuildText)),
    new SlashCommandBuilder().setName("machine").setDescription("Register a configured machine as a Discord category")
      .addSubcommand(sub => sub.setName("pair").setDescription("Issue a private five-minute enrollment code for a Windows/Linux agent"))
      .addSubcommand(sub => sub.setName("revoke").setDescription("Revoke an agent without terminating its processes")
        .addStringOption(o => o.setName("machine").setDescription("Enrolled agent ID").setRequired(true).setAutocomplete(true))
        .addBooleanOption(o => o.setName("confirm").setDescription("Disconnect this agent from the coordinator").setRequired(true)))
      .addSubcommand(sub => sub.setName("add").setDescription("Create or reuse a private machine category")
        .addStringOption(o => o.setName("machine").setDescription("Configured host ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("cwd").setDescription("Default absolute working directory").setMaxLength(500))
        .addStringOption(o => o.setName("name").setDescription("Project/profile name for this category").setMaxLength(100)))
      .addSubcommand(sub => sub.setName("list").setDescription("List registered machine categories"))
      .addSubcommand(sub => sub.setName("bind").setDescription("Bind an existing private category to a machine")
        .addChannelOption(o => o.setName("category").setDescription("Existing Discord category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addStringOption(o => o.setName("machine").setDescription("Configured host ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("cwd").setDescription("Default absolute working directory").setMaxLength(500)))
      .addSubcommand(sub => sub.setName("remove").setDescription("Unbind a machine category without deleting it")
        .addChannelOption(o => o.setName("category").setDescription("Registered category to unbind").addChannelTypes(ChannelType.GuildCategory))
        .addStringOption(o => o.setName("machine").setDescription("Host ID (only when it has one profile)").setAutocomplete(true))),
    new SlashCommandBuilder().setName("terminal").setDescription("Create or manage a terminal channel")
      .addSubcommand(sub => sub.setName("attach").setDescription("Create or reuse a channel for an existing terminal")
        .addStringOption(o => o.setName("session").setDescription("Existing shared terminal; its process is preserved").setRequired(true).setAutocomplete(true))
        .addChannelOption(o => o.setName("category").setDescription("Registered machine category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addStringOption(o => o.setName("name").setDescription("Channel name").setMaxLength(100)))
      .addSubcommand(sub => sub.setName("create-channel").setDescription("Create a child channel with a new default shell")
        .addChannelOption(o => o.setName("category").setDescription("Registered machine category").addChannelTypes(ChannelType.GuildCategory).setRequired(true))
        .addStringOption(o => o.setName("name").setDescription("Channel name").setMaxLength(100))
        .addStringOption(o => o.setName("cwd").setDescription("Absolute terminal directory (default: category directory)").setMaxLength(500).setAutocomplete(true)))
      .addSubcommand(sub => sub.setName("stop").setDescription("Stop this channel's managed terminal")
        .addBooleanOption(o => o.setName("confirm").setDescription("Required confirmation; this stops the remote process").setRequired(true)))
      .addSubcommand(sub => sub.setName("close").setDescription("Stop the terminal and delete this Discord channel")
        .addBooleanOption(o => o.setName("confirm").setDescription("Required confirmation; deletion is irreversible").setRequired(true))),
  ];
}
