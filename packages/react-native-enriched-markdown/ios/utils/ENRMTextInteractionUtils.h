#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Creates a tap recognizer that stays passive during scrolling and rejects
/// drags beyond a tight touch slop on iOS.
ENRMTapRecognizer *ENRMCreateTextTapRecognizer(id target, SEL action);

/// Resolves the link URL at the tap location.
/// If a link is found, calls onLinkPress and returns YES.
/// If no link is found, calls ENRMClearSelection and returns NO.
BOOL ENRMHandleTapOnTextView(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer,
                             void (^onLinkPress)(NSString *url, NSString *sourceType));

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
