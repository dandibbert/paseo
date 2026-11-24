#import "LinkTapUtils.h"
#import "ENRMLinkPillAttachment.h"
#import "ENRMSpoilerTapUtils.h"
#import "ENRMTextHitTest.h"

static BOOL ENRMPointHitsCharacterGlyph(ENRMPlatformTextView *textView, CGPoint point, NSUInteger characterIndex)
{
#if !TARGET_OS_OSX
  NSLayoutManager *layoutManager = textView.layoutManager;
  NSTextContainer *textContainer = textView.textContainer;
  if (!layoutManager || !textContainer) {
    return YES;
  }
  NSRange glyphRange =
      [layoutManager glyphRangeForCharacterRange:NSMakeRange(characterIndex, 1) actualCharacterRange:NULL];
  if (glyphRange.length == 0) {
    return NO;
  }
  CGRect glyphRect = [layoutManager boundingRectForGlyphRange:glyphRange inTextContainer:textContainer];
  CGPoint adjusted = CGPointMake(point.x - textView.textContainerInset.left, point.y - textView.textContainerInset.top);
  return CGRectContainsPoint(CGRectInset(glyphRect, -6.0, -4.0), adjusted);
#else
  (void)textView;
  (void)point;
  (void)characterIndex;
  return YES;
#endif
}

NSString *_Nullable linkURLAtTapLocation(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer)
{
  return linkURLAtPoint(textView, [recognizer locationInView:textView]);
}

NSString *linkSourceTypeAtTapLocation(ENRMPlatformTextView *textView, ENRMTapRecognizer *recognizer)
{
  NSUInteger index = ENRMCharacterIndexForTap(textView, recognizer);
  if (index == NSNotFound)
    return @"markdown";
  return [ENRMGetAttributedText(textView) attribute:@"linkSourceType" atIndex:index effectiveRange:NULL] ?: @"markdown";
}

NSString *_Nullable linkURLAtPoint(ENRMPlatformTextView *textView, CGPoint point)
{
  NSUInteger index = ENRMCharacterIndexAtPoint(textView, point);
  if (index == NSNotFound)
    return nil;
  NSString *url = [ENRMGetAttributedText(textView) attribute:@"linkURL" atIndex:index effectiveRange:NULL];
  if (!url || !ENRMPointHitsCharacterGlyph(textView, point, index))
    return nil;
  return url;
}

NSString *_Nullable linkURLAtRange(ENRMPlatformTextView *textView, NSRange characterRange)
{
  NSAttributedString *attrText = ENRMGetAttributedText(textView);
  if (characterRange.location >= attrText.length) {
    return nil;
  }
  return [attrText attribute:@"linkURL" atIndex:characterRange.location effectiveRange:NULL];
}

NSString *_Nullable linkTitleAtIndex(NSAttributedString *text, NSUInteger index)
{
  if (index >= text.length)
    return nil;
#if !TARGET_OS_OSX
  id attachment = [text attribute:NSAttachmentAttributeName atIndex:index effectiveRange:NULL];
  if ([attachment isKindOfClass:ENRMLinkPillAttachment.class])
    return ((ENRMLinkPillAttachment *)attachment).label;
#endif
  NSRange range;
  id url = [text attribute:@"linkURL" atIndex:index longestEffectiveRange:&range inRange:NSMakeRange(0, text.length)];
  return url ? [text.string substringWithRange:range] : nil;
}

NSDictionary<NSString *, NSString *> *_Nullable imageAtTapLocation(ENRMPlatformTextView *textView,
                                                                   ENRMTapRecognizer *recognizer)
{
  NSUInteger characterIndex = ENRMCharacterIndexForTap(textView, recognizer);
  if (characterIndex == NSNotFound)
    return nil;

  NSAttributedString *attrText = ENRMGetAttributedText(textView);
  if ([attrText attribute:@"linkURL" atIndex:characterIndex effectiveRange:NULL] != nil)
    return nil;

  NSString *url = [attrText attribute:@"imageURL" atIndex:characterIndex effectiveRange:NULL];
  if (!url || !ENRMPointHitsCharacterGlyph(textView, [recognizer locationInView:textView], characterIndex))
    return nil;

  NSString *altText = [attrText attribute:@"imageAltText" atIndex:characterIndex effectiveRange:NULL];
  return @{@"url" : url, @"altText" : altText ?: @""};
}

NSDictionary<NSString *, NSString *> *_Nullable codeBlockAtTapLocation(ENRMPlatformTextView *textView,
                                                                       ENRMTapRecognizer *recognizer)
{
  NSUInteger characterIndex = ENRMCharacterIndexForTap(textView, recognizer);
  if (characterIndex == NSNotFound)
    return nil;

  NSAttributedString *attrText = ENRMGetAttributedText(textView);
  NSString *code = [attrText attribute:@"codeBlockText" atIndex:characterIndex effectiveRange:NULL];
  if (!code)
    return nil;

  NSString *language = [attrText attribute:@"codeBlockLanguage" atIndex:characterIndex effectiveRange:NULL];
  return @{@"code" : code, @"language" : language ?: @""};
}

BOOL isPointOnInteractiveElement(ENRMPlatformTextView *textView, CGPoint point, BOOL includeImages,
                                 BOOL includeCodeBlock)
{
  NSUInteger charIndex = ENRMCharacterIndexAtPoint(textView, point);
  if (charIndex == NSNotFound)
    return NO;

  NSDictionary *attrs = [ENRMGetAttributedText(textView) attributesAtIndex:charIndex effectiveRange:NULL];
  if (attrs[@"linkURL"] != nil && ENRMPointHitsCharacterGlyph(textView, point, charIndex))
    return YES;
  if ([attrs[@"TaskItem"] boolValue] || attrs[SpoilerAttributeName] != nil)
    return YES;

  if (includeImages && attrs[@"imageURL"] != nil && ENRMPointHitsCharacterGlyph(textView, point, charIndex))
    return YES;

  return includeCodeBlock && attrs[@"codeBlockText"] != nil;
}
