import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Text, View } from "react-native";
import { appApprovalsResetRpc } from "../shared/app-rpc";
import { genuiSettings } from "../shared/settings";

export function GenUiSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(genuiSettings);
  const [folders, setFolders] = React.useState<string | null>(null);
  const resetApprovals = useRpc(appApprovalsResetRpc);
  const [resetNote, setResetNote] = React.useState<string | null>(null);

  if (settings.status === "loading") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Loading settings…</Text>
      </View>
    );
  }

  if (settings.status !== "ready") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{settings.error}</Text>
      </View>
    );
  }

  const { values, revision, save } = settings;

  return (
    <View style={{ gap: 16 }}>
      <SettingsSection title="Agent instructions">
        <SettingsCard>
          <SettingsSwitch
            label="Automatically teach new agents Generative UI"
            hint="Appends the 86-component ```ui and ```app reference to new agents' system prompt on creation."
            value={values.autoInstructions}
            onValueChange={(autoInstructions) => {
              void save({ ...values, autoInstructions }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Network and web lookups">
        <SettingsCard>
          <SettingsSwitch
            label="Web lookups"
            hint="Lets ImageSearch (Wikimedia Commons), Map (Photon geocoding and OpenStreetMap tiles), and https Image links fetch through the Paseo daemon with private-IP protection and caching."
            value={values.webLookups}
            onValueChange={(webLookups) => {
              void save({ ...values, webLookups }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Interactive apps">
        <SettingsCard>
          <SettingsSwitch
            label="Allow CDN libraries"
            hint="Lets ```app pages load scripts, styles and fonts from cdnjs, unpkg, jsDelivr (npm), Tailwind, jQuery and Google Fonts. Everything else stays blocked."
            value={values.allowCdnLibraries}
            onValueChange={(allowCdnLibraries) => {
              void save({ ...values, allowCdnLibraries }, revision);
            }}
          />
          <SettingsSwitch
            label="Allow apps to call AI"
            hint="Lets an app ask Claude Haiku (on your Claude subscription) through paseo.ai. Each app still asks first."
            value={values.allowAppAi}
            onValueChange={(allowAppAi) => {
              void save({ ...values, allowAppAi }, revision);
            }}
          />
          <SettingsAction
            label="Reset app approvals"
            hint={resetNote ?? "Forgets every network, message, link and AI approval you gave to apps."}
            actionLabel="Reset"
            onPress={() => {
              void resetApprovals({}).then(
                ({ removed }) => setResetNote(`Removed ${removed} saved approval${removed === 1 ? "" : "s"}.`),
                () => setResetNote("Could not reset approvals."),
              );
            }}
          />
          <SettingsSwitch
            label="Run apps automatically on the phone"
            hint="On: apps start as soon as they appear, on phones too. Off: on a phone, an app waits for a tap on Run app. Desktop and web always start apps."
            value={values.autoRunAppsOnPhone}
            onValueChange={(autoRunAppsOnPhone) => {
              void save({ ...values, autoRunAppsOnPhone }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Files">
        <SettingsCard>
          <SettingsInput
            label="Extra folders"
            hint="Comma-separated folders, besides the workspace, thread storage and /tmp, that Load, Snippet and Image can read."
            initialValue={values.extraFolders}
            placeholder="~/dev/scratch"
            onChangeText={setFolders}
          />
          <SettingsAction
            label="Apply folder changes"
            actionLabel="Save"
            disabled={folders === null || folders === values.extraFolders}
            onPress={() => {
              if (folders !== null) void save({ ...values, extraFolders: folders }, revision);
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
