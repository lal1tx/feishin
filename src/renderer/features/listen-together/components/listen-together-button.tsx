import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { resyncListenTogether } from '/@/renderer/features/listen-together/hooks/use-listen-together-sync';
import {
    isListenTogetherSupported,
    listenTogetherActions,
    useListenTogether,
} from '/@/renderer/features/listen-together/store/listen-together.store';
import { useCurrentServer, useListenTogetherSettings } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Code } from '/@/shared/components/code/code';
import { CopyButton } from '/@/shared/components/copy-button/copy-button';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Popover } from '/@/shared/components/popover/popover';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';

export const ListenTogetherButton = () => {
    const { serverUrl } = useListenTogetherSettings();
    const server = useCurrentServer();

    // Fully gated behind the setting, nothing changes for users who don't use it.
    if (!serverUrl || !isListenTogetherSupported(server?.type)) {
        return null;
    }

    return <ListenTogetherPopover />;
};

const ListenTogetherPopover = () => {
    const { t } = useTranslation();
    const session = useListenTogether();
    const [opened, setOpened] = useState(false);
    const [code, setCode] = useState('');

    const inSession = session.status !== 'idle';
    const tooltip =
        session.role === 'follower' && session.hostUsername
            ? t('player.listenTogether_following', { host: session.hostUsername })
            : t('player.listenTogether');

    return (
        <Popover onChange={setOpened} opened={opened} position="top" withArrow>
            <Popover.Target>
                <ActionIcon
                    icon="listenTogether"
                    iconProps={{
                        color: session.status === 'connected' ? 'primary' : undefined,
                        size: 'lg',
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpened((prev) => !prev);
                    }}
                    size="sm"
                    tooltip={{ label: tooltip, openDelay: 0 }}
                    variant="subtle"
                />
            </Popover.Target>
            <Popover.Dropdown maw={360} miw={300} onClick={(e) => e.stopPropagation()} p="md">
                <Stack gap="sm">
                    <Text fw={600} size="sm">
                        {t('player.listenTogether')}
                    </Text>

                    {!inSession && (
                        <>
                            <Text isMuted size="xs">
                                {t('player.listenTogether_description')}
                            </Text>
                            <Button onClick={listenTogetherActions.createSession} variant="filled">
                                {t('player.listenTogether_start')}
                            </Button>
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    if (code.trim()) listenTogetherActions.joinSession(code);
                                }}
                            >
                                <Group gap="xs" wrap="nowrap">
                                    <TextInput
                                        autoComplete="off"
                                        onChange={(e) => setCode(e.currentTarget.value)}
                                        placeholder={t('player.listenTogether_codePlaceholder')}
                                        style={{ flex: 1 }}
                                        value={code}
                                    />
                                    <Button disabled={!code.trim()} type="submit" variant="default">
                                        {t('player.listenTogether_join')}
                                    </Button>
                                </Group>
                            </form>
                            <Text isMuted size="xs">
                                {t('player.listenTogether_joinWarning')}
                            </Text>
                        </>
                    )}

                    {(session.status === 'connecting' || session.status === 'reconnecting') && (
                        <Text isMuted size="sm">
                            {t(
                                session.status === 'connecting'
                                    ? 'player.listenTogether_connecting'
                                    : 'player.listenTogether_reconnecting',
                            )}
                        </Text>
                    )}

                    {session.status === 'connected' && session.role === 'host' && session.code && (
                        <Stack gap={4}>
                            <Text size="sm">{t('player.listenTogether_hosting')}</Text>
                            <Group gap={6}>
                                <Code fz="xl">{session.code}</Code>
                                <CopyButton timeout={2000} value={session.code}>
                                    {({ copied, copy }) => (
                                        <ActionIcon
                                            icon={copied ? 'check' : 'clipboardCopy'}
                                            onClick={copy}
                                            size="sm"
                                            tooltip={{
                                                label: t('player.listenTogether_copied'),
                                            }}
                                            variant="transparent"
                                        />
                                    )}
                                </CopyButton>
                            </Group>
                        </Stack>
                    )}

                    {session.status === 'connected' && session.role === 'follower' && (
                        <Text size="sm">
                            {session.hostConnected
                                ? t('player.listenTogether_following', {
                                      host: session.hostUsername,
                                  })
                                : t('player.listenTogether_hostAway')}
                        </Text>
                    )}

                    {session.status === 'connected' && session.members.length > 0 && (
                        <Stack gap={2}>
                            <Text fw={600} isMuted size="xs">
                                {t('player.listenTogether_members')}
                            </Text>
                            {session.members.map((member, i) => (
                                <Group gap={6} key={`${member.username}-${i}`}>
                                    <Icon
                                        icon={member.role === 'host' ? 'listenTogether' : 'user'}
                                    />
                                    <Text size="sm">{member.username}</Text>
                                </Group>
                            ))}
                        </Stack>
                    )}

                    {inSession && (
                        <Group gap="xs" grow>
                            {session.role === 'follower' && session.status === 'connected' && (
                                <Button onClick={resyncListenTogether} variant="default">
                                    {t('player.listenTogether_resync')}
                                </Button>
                            )}
                            <Button
                                color="red"
                                onClick={listenTogetherActions.leaveSession}
                                variant="subtle"
                            >
                                {t(
                                    session.role === 'host'
                                        ? 'player.listenTogether_end'
                                        : 'player.listenTogether_leave',
                                )}
                            </Button>
                        </Group>
                    )}
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};
