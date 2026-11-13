import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import {
    useListenTogetherSettings,
    useSettingsStoreActions,
} from '/@/renderer/store/settings.store';
import { TextInput } from '/@/shared/components/text-input/text-input';

export const ListenTogetherSettings = memo(() => {
    const { t } = useTranslation();
    const settings = useListenTogetherSettings();
    const { setSettings } = useSettingsStoreActions();

    const options: SettingOption[] = [
        {
            control: (
                <TextInput
                    defaultValue={settings.serverUrl}
                    onBlur={(e) => {
                        setSettings({
                            listenTogether: { serverUrl: e.currentTarget.value.trim() },
                        });
                    }}
                    placeholder="ws://localhost:4534"
                />
            ),
            description: t('setting.listenTogetherServer', { context: 'description' }),
            title: t('setting.listenTogetherServer'),
        },
    ];

    return <SettingsSection options={options} title={t('player.listenTogether')} />;
});
